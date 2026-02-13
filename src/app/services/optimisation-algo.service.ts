import { Adresse } from '../data/adresse';
import { OptimizationResult } from './OptimizationResult';

/**
 * Répartition équitable des points entre les chauffeurs
 * 
 * Objectifs :
 * 1. Chaque chauffeur reçoit le même nombre de livraisons (±1)
 * 2. ORS limite à 50 points par appel (erreur 413 sinon)
 * 3. ORS limite à 3 véhicules par appel
 * 4. On regroupe pour réduire le nombre d'appels API
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
  // Le parking est toujours le dernier point
  const parking = adresses[adresses.length - 1];
  const jobs = adresses.slice(0, -1);
  const totalPoints = jobs.length;
  
  console.log('\n' + '='.repeat(80));
  console.log('REPARTITION EQUITABLE - VALIDATION');
  console.log('='.repeat(80));
  console.log(`\nPoints a livrer: ${totalPoints}`);
  console.log(`Vehicules demandes: ${nbVehiculesDemandes}`);
  console.log(`Temps max par vehicule: ${maxTimePerVehicule}s`);

  // Constantes imposées par ORS
  const POINTS_MAX_PAR_PAQUET = 50;
  const VEHICULES_MAX_PAR_PAQUET = 3;
  
  // Vérification du nombre minimum de véhicules nécessaires
  // Exemple: 376 points nécessitent au moins 8 véhicules (8×50 = 400)
  const vehiculesMinimum = Math.ceil(totalPoints / POINTS_MAX_PAR_PAQUET);
  
  if (nbVehiculesDemandes < vehiculesMinimum) {
    console.log(`\nERREUR: Vehicules insuffisants`);
    console.log(`   • Besoin minimum: ${vehiculesMinimum} vehicules`);
    console.log(`   • Disponible: ${nbVehiculesDemandes} vehicules`);
    
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
        alerte: `${nbVehiculesDemandes}v < ${vehiculesMinimum}v minimum requis`
      }
    };
  }

  // Distribution équitable des points
  // Exemple: 376 points / 10 véhicules = 37 points chacun + 6 en rab
  const pointsParVehicule = Math.floor(totalPoints / nbVehiculesDemandes);
  let restePoints = totalPoints - (pointsParVehicule * nbVehiculesDemandes);
  
  console.log(`\nRepartition par vehicule:`);
  console.log(`   • ${pointsParVehicule} points par vehicule (base)`);
  console.log(`   • ${restePoints} vehicule(s) avec +1 point`);
  
  // Vérification: aucun véhicule ne doit dépasser 50 points
  if (pointsParVehicule + 1 > POINTS_MAX_PAR_PAQUET) {
    console.log(`\nERREUR: Trop de points par vehicule`);
    console.log(`   • Maximum ORS: ${POINTS_MAX_PAR_PAQUET}pts par vehicule`);
    console.log(`   • Demande: ~${pointsParVehicule}pts par vehicule`);
    console.log(`\nSolution: Augmenter le nombre de vehicules`);
    
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
        alerte: `${pointsParVehicule}pts/veh > ${POINTS_MAX_PAR_PAQUET}pts max`
      }
    };
  }

  // Tri des points par longitude (ouest vers est) pour des tournées cohérentes
  const sorted = [...jobs].sort((a, b) => a.lng - b.lng);
  let indexPoint = 0;
  
  // Construction du tableau indiquant le nombre de points par véhicule
  const vehiculesPoints: number[] = [];
  for (let i = 0; i < nbVehiculesDemandes; i++) {
    let pts = pointsParVehicule;
    if (restePoints > 0) {
      pts++;
      restePoints--;
    }
    vehiculesPoints.push(pts);
  }

  console.log(`\nDistribution finale:`);
  console.log(`   • Min: ${Math.min(...vehiculesPoints)}pts, Max: ${Math.max(...vehiculesPoints)}pts`);

  // Regroupement des véhicules en paquets pour économiser les appels API
  console.log(`\nRegroupement (max ${POINTS_MAX_PAR_PAQUET}pts par paquet)...`);
  
  const paquets: Adresse[][] = [];
  const allocations: number[] = [];
  let bufferPoints: Adresse[] = [];
  let bufferVehicules = 0;
  let bufferTotalPts = 0;
  
  // Parcours des véhicules pour les regrouper
  for (let i = 0; i < nbVehiculesDemandes; i++) {
    const ptsVehicule = vehiculesPoints[i];
    const adressesVehicule = sorted.slice(indexPoint, indexPoint + ptsVehicule);
    indexPoint += ptsVehicule;
    
    // Vérification de sécurité (normalement déjà filtré)
    if (ptsVehicule > POINTS_MAX_PAR_PAQUET) {
      console.log(`\nERREUR: Paquet impossible: ${ptsVehicule}pts > ${POINTS_MAX_PAR_PAQUET}pts`);
      console.log(`   Solution: Augmenter le nombre de vehicules`);
      
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
          alerte: `${ptsVehicule}pts > ${POINTS_MAX_PAR_PAQUET}pts max`
        }
      };
    }
    
    bufferPoints.push(...adressesVehicule);
    bufferVehicules++;
    bufferTotalPts += ptsVehicule;
    
    // Si le buffer dépasse 50 points, on garde le véhicule précédent
    if (bufferTotalPts > POINTS_MAX_PAR_PAQUET) {
      const lastPoints = ptsVehicule;
      bufferPoints = bufferPoints.slice(0, -lastPoints);
      bufferVehicules--;
      bufferTotalPts -= lastPoints;
      
      paquets.push([...bufferPoints]);
      allocations.push(bufferVehicules);
      
      bufferPoints = [...adressesVehicule];
      bufferVehicules = 1;
      bufferTotalPts = ptsVehicule;
    }
    
    // Si on atteint 3 véhicules, on valide le paquet
    if (bufferVehicules === VEHICULES_MAX_PAR_PAQUET) {
      paquets.push([...bufferPoints]);
      allocations.push(VEHICULES_MAX_PAR_PAQUET);
      bufferPoints = [];
      bufferVehicules = 0;
      bufferTotalPts = 0;
    }
  }
  
  // Dernier paquet avec ce qui reste
  if (bufferPoints.length > 0) {
    paquets.push([...bufferPoints]);
    allocations.push(bufferVehicules);
  }

  console.log(`\nAllocation finale:`);
  console.log(`   • ${paquets.length} paquet(s) pour ${nbVehiculesDemandes} vehicules`);
  console.log(`   • Economie: ${nbVehiculesDemandes - paquets.length} appels ORS`);
  
  let totalPointsAlloues = 0;
  let totalVehiculesAlloues = 0;
  
  allocations.forEach((alloc, i) => {
    totalVehiculesAlloues += alloc;
    totalPointsAlloues += paquets[i].length;
    const ratio = Math.round(paquets[i].length / alloc);
    console.log(`   • Paquet ${i+1}: ${paquets[i].length}pts, ${alloc}v (${ratio}pts/veh)`);
  });
  
  console.log(`   • Total: ${totalPointsAlloues}/${totalPoints} points, ${totalVehiculesAlloues}/${nbVehiculesDemandes} vehicules`);

  // Appels à ORS pour chaque paquet
  console.log(`\nOptimisation (${paquets.length} appels ORS)...`);
  
  const results: OptimizationResult[] = [];
  let totalDuree = 0;
  let totalVehiculesUtilises = 0;
  let totalPointsLivres = 0;
  
  for (let i = 0; i < paquets.length; i++) {
    console.log(`\nPaquet ${i+1}/${paquets.length} (${paquets[i].length}pts, ${allocations[i]}v)...`);
    
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
      
      // Calcul des points réellement livrés (steps - départ - retour)
      const pointsDansPaquet = result.routes.reduce((acc, route) => 
        acc + Math.max(0, route.steps.length - 2), 0
      );
      totalPointsLivres += pointsDansPaquet;
      
      const statut = pointsDansPaquet === paquets[i].length ? 'OK' : 'Attention';
      console.log(`   ${statut} ${result.routes.length}/${allocations[i]} vehicules`);
      console.log(`   ${pointsDansPaquet}/${paquets[i].length} points`);
      
    } catch (error) {
      console.error(`   Erreur ORS:`, error);
      console.log(`   Ce paquet depasse probablement 50pts ou 3v`);
      
      const vehiculesNecessaires = Math.ceil(paquets[i].length / POINTS_MAX_PAR_PAQUET);
      console.log(`   Solution: Augmenter le nombre de vehicules`);
    }
  }

  const taux = totalPoints > 0 ? (totalPointsLivres / totalPoints) * 100 : 0;
  
  console.log('\n' + '='.repeat(80));
  console.log('RAPPORT FINAL');
  console.log('='.repeat(80));
  console.log(`\nStatistiques:`);
  console.log(`   • Points: ${totalPoints}`);
  console.log(`   • Points livres: ${totalPointsLivres}`);
  console.log(`   • Taux: ${taux.toFixed(1)}%`);
  console.log(`   • Paquets: ${paquets.length}`);
  console.log(`   • Vehicules demandes: ${nbVehiculesDemandes}`);
  console.log(`   • Vehicules utilises: ${totalVehiculesUtilises}`);
  console.log(`   • Appels ORS: ${paquets.length} (${nbVehiculesDemandes - paquets.length} economies)`);
  
  let alerte = '';
  
  if (totalPointsLivres < totalPoints) {
    const pointsNonLivres = totalPoints - totalPointsLivres;
    const vehiculesRequis = Math.ceil(totalPoints / POINTS_MAX_PAR_PAQUET);
    
    alerte = `${pointsNonLivres} points non livres avec ${nbVehiculesDemandes}v`;
    console.log(`\nAttention: ${alerte}`);
    console.log(`\nSolutions:`);
    console.log(`   1. Augmenter le nombre de vehicules`);
    console.log(`   2. Augmenter le temps par vehicule (actuel: ${maxTimePerVehicule}s)`);
  } else {
    console.log(`\nSucces: 100% des points livres`);
    console.log(`   • Equite: ~${Math.round(totalPointsLivres / totalVehiculesUtilises)} pts/vehicule`);
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