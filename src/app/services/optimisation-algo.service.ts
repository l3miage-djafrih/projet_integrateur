import { Adresse } from '../data/adresse';
import { OptimizationResult } from './OptimizationResult';

/**
 * 🚚 RÉPARTITION ÉQUITABLE DES POINTS
 * 
 * Ce qu'on veut faire :
 * 1. Chaque chauffeur doit avoir le MÊME nombre de livraisons (±1) → pas de jaloux
 * 2. ORS ne peut pas traiter plus de 50 points par appel → sinon erreur 413
 * 3. ORS ne peut pas gérer plus de 3 véhicules par appel → limite API
 * 4. On regroupe les petits paquets pour économiser des appels API
 */
export async function optimiseEquitable(
  adresses: readonly Adresse[],
  nbVehiculesDemandes: number,
  maxTimePerVehicule: number,
  optimizeCallback: (params: {
    nbVehicules: number,
    maxTimePerVehicule: number,
    adresses: readonly Adresse[],
    parking: Adresse
  }) => Promise<OptimizationResult>
): Promise<{
  results: OptimizationResult[];
  stats: {
    totalPoints: number;
    vehiculesDemandes: number;
    vehiculesMinimum: number;
    vehiculesUtilises: number;
    totalPaquets: number;
    totalDuree: number;
    totalCout: number;
    alerte?: string;
  }
}> {
  // Le dernier point de la liste est TOUJOURS le parking
  const parking = adresses[adresses.length - 1];
  // Tous les autres points sont à livrer
  const jobs = adresses.slice(0, -1);
  const totalPoints = jobs.length;
  
  console.log('\n' + '='.repeat(80));
  console.log('🚚 RÉPARTITION ÉQUITABLE - VALIDATION');
  console.log('='.repeat(80));
  console.log(`\n📦 Points à livrer: ${totalPoints}`);
  console.log(`🚛 Véhicules demandés: ${nbVehiculesDemandes}`);
  console.log(`⏱️  Temps max/véhicule: ${maxTimePerVehicule}s`);

  // --- CONSTANTES DE BASE (imposées par ORS) ---
  const POINTS_MAX_PAR_PAQUET = 50;  // LIMITE ABSOLUE : 50 points par appel
  const VEHICULES_MAX_PAR_PAQUET = 3; // LIMITE ABSOLUE : 3 véhicules par appel
  
  // ------------------------------------------------------------
  // ÉTAPE 1 : VÉRIFICATION DE BASE
  // ------------------------------------------------------------
  // Est-ce qu'on a assez de véhicules pour couvrir tous les points ?
  // Si on a 376 points, il faut au moins 8 véhicules (8×50 = 400)
  const vehiculesMinimum = Math.ceil(totalPoints / POINTS_MAX_PAR_PAQUET);
  
  if (nbVehiculesDemandes < vehiculesMinimum) {
    console.log(`\n❌ VÉHICULES INSUFFISANTS !`);
    console.log(`   • Besoin minimum: ${vehiculesMinimum} véhicules (50pts max par appel)`);
    console.log(`   • Disponible: ${nbVehiculesDemandes} véhicules`);
    
    // On bloque tout de suite - pas la peine d'aller plus loin
    return {
      results: [],
      stats: {
        totalPoints,
        vehiculesDemandes: nbVehiculesDemandes,
        vehiculesMinimum: 0,
        vehiculesUtilises: 0,
        totalPaquets: 0,
        totalDuree: 0,
        totalCout: 0,
        alerte: `❌ ${nbVehiculesDemandes}v < ${vehiculesMinimum}v minimum requis`
      }
    };
  }

  // ------------------------------------------------------------
  // ÉTAPE 2 : DISTRIBUTION ÉQUITABLE DES POINTS
  // ------------------------------------------------------------
  // On calcule combien de points chaque véhicule va prendre
  // Exemple: 376 points / 10 véhicules = 37 points chacun + 6 en rab'
  const pointsParVehicule = Math.floor(totalPoints / nbVehiculesDemandes);
  let restePoints = totalPoints - (pointsParVehicule * nbVehiculesDemandes);
  
  console.log(`\n📊 ÉQUITÉ PAR VÉHICULE:`);
  console.log(`   • ${pointsParVehicule} points/véhicule (base)`);
  console.log(`   • ${restePoints} véhicule(s) avec +1 point`);
  
  // Vérification : est-ce qu'un véhicule se tape plus de 50 points ?
  // Si oui, c'est mort d'avance
  if (pointsParVehicule + 1 > POINTS_MAX_PAR_PAQUET) {
    console.log(`\n❌ POINTS PAR VÉHICULE TROP ÉLEVÉ !`);
    console.log(`   • Maximum ORS: ${POINTS_MAX_PAR_PAQUET}pts par véhicule`);
    console.log(`   • Demandé: ~${pointsParVehicule}pts par véhicule`);
    console.log(`\n💡 SOLUTION: Augmentez le nombre de véhicules`);
    
    return {
      results: [],
      stats: {
        totalPoints,
        vehiculesDemandes: nbVehiculesDemandes,
        vehiculesMinimum: 0,
        vehiculesUtilises: 0,
        totalPaquets: 0,
        totalDuree: 0,
        totalCout: 0,
        alerte: `❌ ${pointsParVehicule}pts/véh > ${POINTS_MAX_PAR_PAQUET}pts max`
      }
    };
  }

  // ------------------------------------------------------------
  // ÉTAPE 3 : AFFECTATION DES POINTS À CHAQUE VÉHICULE
  // ------------------------------------------------------------
  // On trie les points par longitude (ouest → est)
  // C'est plus logique pour les tournées
  const sorted = [...jobs].sort((a, b) => a.lng - b.lng);
  let indexPoint = 0;  // Où on en est dans la liste des points
  
  // On fabrique un tableau qui dit : "Véhicule 1 : X points, Véhicule 2 : Y points..."
  const vehiculesPoints: number[] = [];
  for (let i = 0; i < nbVehiculesDemandes; i++) {
    let pts = pointsParVehicule;
    if (restePoints > 0) {
      pts++;
      restePoints--;
    }
    vehiculesPoints.push(pts);
  }

  console.log(`\n📦 DISTRIBUTION PAR VÉHICULE:`);
  console.log(`   • Min: ${Math.min(...vehiculesPoints)}pts, Max: ${Math.max(...vehiculesPoints)}pts`);

  // ------------------------------------------------------------
  // ÉTAPE 4 : REGROUPEMENT OPTIMAL
  // ------------------------------------------------------------
  // Objectif : mettre plusieurs véhicules dans le même appel ORS
  // pour économiser des appels API
  console.log(`\n🔄 REGROUPEMENT OPTIMAL (max ${POINTS_MAX_PAR_PAQUET}pts/paquet)...`);
  
  const paquets: Adresse[][] = [];
  const allocations: number[] = [];
  let bufferPoints: Adresse[] = [];    // Les points en attente
  let bufferVehicules = 0;            // Les véhicules en attente
  let bufferTotalPts = 0;            // Le total des points en attente
  
  // On passe en revue chaque véhicule et on essaie de le caser dans le buffer
  for (let i = 0; i < nbVehiculesDemandes; i++) {
    const ptsVehicule = vehiculesPoints[i];
    const adressesVehicule = sorted.slice(indexPoint, indexPoint + ptsVehicule);
    indexPoint += ptsVehicule;
    
    // CAS PATHOLOGIQUE : un véhicule avec plus de 50 points à lui tout seul
    // Normalement on l'a déjà filtré avant, mais on vérifie quand même
    if (ptsVehicule > POINTS_MAX_PAR_PAQUET) {
      console.log(`\n❌ PAQUET IMPOSSIBLE: ${ptsVehicule}pts > ${POINTS_MAX_PAR_PAQUET}pts`);
      console.log(`   💡 Solution: Augmentez le nombre de véhicules`);
      
      return {
        results: [],
        stats: {
          totalPoints,
          vehiculesDemandes: nbVehiculesDemandes,
          vehiculesMinimum: 0,
          vehiculesUtilises: 0,
          totalPaquets: 0,
          totalDuree: 0,
          totalCout: 0,
          alerte: `❌ ${ptsVehicule}pts > ${POINTS_MAX_PAR_PAQUET}pts max`
        }
      };
    }
    
    // On ajoute ce véhicule au buffer
    bufferPoints.push(...adressesVehicule);
    bufferVehicules++;
    bufferTotalPts += ptsVehicule;
    
    // Si le buffer dépasse 50 points, on garde le véhicule précédent
    // et on met le nouveau dans un nouveau buffer
    if (bufferTotalPts > POINTS_MAX_PAR_PAQUET) {
      const lastPoints = ptsVehicule;
      // On retire le dernier véhicule ajouté
      bufferPoints = bufferPoints.slice(0, -lastPoints);
      bufferVehicules--;
      bufferTotalPts -= lastPoints;
      
      // On valide le paquet avec les véhicules précédents
      paquets.push([...bufferPoints]);
      allocations.push(bufferVehicules);
      
      // On commence un nouveau buffer avec le véhicule courant
      bufferPoints = [...adressesVehicule];
      bufferVehicules = 1;
      bufferTotalPts = ptsVehicule;
    }
    
    // Si on atteint 3 véhicules dans le buffer, on valide le paquet
    if (bufferVehicules === VEHICULES_MAX_PAR_PAQUET) {
      paquets.push([...bufferPoints]);
      allocations.push(VEHICULES_MAX_PAR_PAQUET);
      bufferPoints = [];
      bufferVehicules = 0;
      bufferTotalPts = 0;
    }
  }
  
  // Dernier paquet : ce qui reste dans le buffer
  if (bufferPoints.length > 0) {
    paquets.push([...bufferPoints]);
    allocations.push(bufferVehicules);
  }

  console.log(`\n🚛 ALLOCATION FINALE:`);
  console.log(`   • ${paquets.length} paquet(s) pour ${nbVehiculesDemandes} véhicules`);
  console.log(`   • Économie: ${nbVehiculesDemandes - paquets.length} appels ORS (${Math.round((1 - paquets.length/nbVehiculesDemandes)*100)}%)`);
  
  // On affiche le détail des paquets créés
  let totalPointsAlloues = 0;
  let totalVehiculesAlloues = 0;
  
  allocations.forEach((alloc, i) => {
    totalVehiculesAlloues += alloc;
    totalPointsAlloues += paquets[i].length;
    const ratio = Math.round(paquets[i].length / alloc);
    console.log(`   • Paquet ${i+1}: ${paquets[i].length}pts, ${alloc}v (${ratio}pts/véh)`);
  });
  
  console.log(`   • TOTAL: ${totalPointsAlloues}/${totalPoints} points, ${totalVehiculesAlloues}/${nbVehiculesDemandes} véhicules`);

  // ------------------------------------------------------------
  // ÉTAPE 5 : APPEL À ORS 
  // ------------------------------------------------------------
  console.log(`\n⚡ Optimisation (${paquets.length} appels ORS)...`);
  
  const results: OptimizationResult[] = [];
  let totalDuree = 0;
  let totalVehiculesUtilises = 0;
  let totalPointsLivres = 0;
  
  // Pour chaque paquet, on appelle ORS
  for (let i = 0; i < paquets.length; i++) {
    console.log(`\n🔄 Paquet ${i+1}/${paquets.length} (${paquets[i].length}pts, ${allocations[i]}v)...`);
    
    try {
      const result = await optimizeCallback({
        nbVehicules: allocations[i],
        maxTimePerVehicule,
        adresses: paquets[i],
        parking
      });
      
      results.push(result);
      totalDuree += result.summary.duration;
      totalVehiculesUtilises += result.routes.length;
      
      // ORS nous dit combien de points il a RÉELLEMENT livrés
      const pointsDansPaquet = result.routes.reduce((acc, route) => 
        acc + Math.max(0, route.steps.length - 2), 0
      );
      totalPointsLivres += pointsDansPaquet;
      
      // On check si ORS a tout livré ou pas
      const statut = pointsDansPaquet === paquets[i].length ? '✅' : '⚠️';
      console.log(`   ${statut} ${result.routes.length}/${allocations[i]} véhicules`);
      console.log(`   📦 ${pointsDansPaquet}/${paquets[i].length} points`);
      
    } catch (error) {
      // Grosse erreur : ORS n'a pas aimé notre paquet
      console.error(`   ❌ Erreur ORS:`, error);
      console.log(`   💡 Ce paquet dépasse 50pts ou 3v`);
      
      const vehiculesNecessaires = Math.ceil(paquets[i].length / POINTS_MAX_PAR_PAQUET);
      console.log(`   💡 Solution: Augmentezle nombres de véhicules`);
    }
  }

  // ------------------------------------------------------------
  // ÉTAPE 6 : RAPPORT FINAL - On dit à l'utilisateur ce qui s'est passé
  // ------------------------------------------------------------
  const taux = totalPoints > 0 ? (totalPointsLivres / totalPoints) * 100 : 0;
  
  console.log('\n' + '='.repeat(80));
  console.log('🏁 RAPPORT FINAL');
  console.log('='.repeat(80));
  console.log(`\n📊 STATISTIQUES:`);
  console.log(`   • 📦 Points: ${totalPoints}`);
  console.log(`   • 📦 Points livrés: ${totalPointsLivres}`);
  console.log(`   • 📊 Taux: ${taux.toFixed(1)}%`);
  console.log(`   • 📦 Paquets: ${paquets.length}`);
  console.log(`   • 🚛 Demandés: ${nbVehiculesDemandes}`);
  console.log(`   • 🚛 Utilisés: ${totalVehiculesUtilises}`);
  console.log(`   • 📞 Appels ORS: ${paquets.length} (${nbVehiculesDemandes - paquets.length} économisés)`);
  
  let alerte = '';
  
  if (totalPointsLivres < totalPoints) {
    const pointsNonLivres = totalPoints - totalPointsLivres;
    const vehiculesRequis = Math.ceil(totalPoints / POINTS_MAX_PAR_PAQUET);
    
    alerte = `⚠️ ${pointsNonLivres} points non livrés avec ${nbVehiculesDemandes}v`;
    console.log(`\n🚨 ALERTE: ${alerte}`);
    console.log(`\n💡 SOLUTIONS:`);
    console.log(`   1. Augmentez le nombre de vehicule`);
    console.log(`   2. Augmentez le temps par véhicule (actuel: ${maxTimePerVehicule}s)`);
  } else {
    console.log(`\n🎉 SUCCÈS: 100% DES POINTS LIVRÉS !`);
    console.log(`   • Équité: ~${Math.round(totalPointsLivres / totalVehiculesUtilises)} pts/véhicule`);
  }
  
  return {
    results,
    stats: {
      totalPoints,
      vehiculesDemandes: nbVehiculesDemandes,
      vehiculesMinimum: 0,
      vehiculesUtilises: totalVehiculesUtilises,
      totalPaquets: paquets.length,
      totalDuree,
      totalCout: 0,
      alerte
    }
  };
}