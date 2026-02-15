import { inject, Injectable } from '@angular/core';
import { Adresse } from '../data/adresse';
import { Carto } from './carto';
import { OptimizationResult } from './OptimizationResult';

// TYPES INTERNES
interface IndexedAddress {
  address: Adresse;
  idx: number;
}

export interface OptimizationAdvancedResult {
  results: OptimizationResult[];
  delivered: number[]; // indices des adresses livrées
  undelivered: number[]; // indices des adresses NON livrées
  stats: {
    totalAddresses: number;
    deliveredCount: number;
    undeliveredCount: number;
    successRate: number;
    totalRoutes: number;
    failedRoutes: number;
  };
}

/**
 * CONVENTION MATRICE — valable pour 50, 100, 400 adresses ou plus :
 *
 * Les adresses de livraison sont indexées de 0 à n-1 dans la matrice
 * parkingIdx est calculé dynamiquement à chaque appel :
 * parkingIdx = adresses.length
 */
const addrToMatrix = (idx: number): number => idx;

@Injectable({
  providedIn: 'root',
})
export class OptimizeAdvancedService {
  private readonly _carto = inject(Carto);

  /**
   * Fonctionne pour n'importe quelle taille de dataset (50, 100, 400...).
   *
   * Stratégie simplifiée :
   * 1. Clustering basé sur les durées réelles → clusters temporellement compacts
   * 2. Appel ORS par cluster qui fait l'optimisation complète
   * 3. Tracking des adresses livrées
   */
  public async optimizeAdvanced(params: {
    nbVehicules: number;
    maxTimePerVehicule: number;
    adresses: readonly Adresse[];
    parking: Adresse;
    preCalculatedMatrix?: { distances: number[][]; durations: number[][] };
  }): Promise<OptimizationAdvancedResult> {
    const { nbVehicules, maxTimePerVehicule, adresses, parking, preCalculatedMatrix } = params;
    const parkingIdx = adresses.length;

    console.log(`optimizeAdvanced: ${adresses.length} adresses, ${nbVehicules} véhicules`);

    // Etape 1 : récupération de la matrice
    let dist: number[][];
    let dur: number[][];

    if (preCalculatedMatrix) {
      dist = preCalculatedMatrix.distances;
      dur = preCalculatedMatrix.durations;
      console.log(`Matrice pré-calculée (${dist.length}×${dist[0]?.length})`);

      // Vérification : la matrice doit faire (n+1) × (n+1)
      const expected = adresses.length + 1;
      if (dist.length !== expected || dist[0]?.length !== expected) {
        throw new Error(
          ` Matrice ${dist.length}×${dist[0]?.length} incohérente avec ${adresses.length} adresses de livraison.\n` +
            ` Attendu : ${expected}×${expected} (${adresses.length} livraisons + 1 parking en dernière position)`
        );
      }
    } else {
      // Génère la matrice sur [...adresses, parking]
      const m = await this._carto.getDistanceMatrix([...adresses, parking]);
      dist = m.distances;
      dur = m.durations;
    }

    // Étape 2 : clustering basé sur les durées réelles
    console.log('Etape 2 : clustering basé sur les durées réelles');
    const indexed: IndexedAddress[] = adresses.map((address, idx) => ({ address, idx }));
    const clusters = this.durationKMedoids(indexed, nbVehicules, maxTimePerVehicule, dur, parkingIdx);
    console.log('Tailles des clusters :', clusters.map(c => c.length));

    // Etape 3 : appel ORS par cluster + tracking
    console.log('Etape 3 : appel ORS par cluster...');
    const results: OptimizationResult[] = [];
    const deliveredSet = new Set<number>();
    let failedRoutesCount = 0;

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      if (cluster.length === 0) continue;

      const clusterAddresses = cluster.map(p => adresses[p.idx]);
      console.log(` Cluster ${i + 1}/${clusters.length} → ${clusterAddresses.length} adresses`);

      // Split si > 50 (sécurité API ORS)
      const chunks = this.chunkArray(clusterAddresses, 50);
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const chunkOriginalIndices = cluster
          .slice(chunkIdx * 50, (chunkIdx + 1) * 50)
          .map(p => p.idx);

        try {
          const result = await this._carto.optimize({
            nbVehicules: 1,
            maxTimePerVehicule,
            adresses: chunk,
            parking,
          });

          results.push(result);

          // Tracker les adresses effectivement livrées par ORS
          if (result.routes.length > 0) {
            result.routes[0].steps.forEach(step => {
              // Seuls les steps de type "job" ont un id
              if (step.type === 'job') {
                // step.id est l'index dans le chunk
                const originalIdx = chunkOriginalIndices[step.id];
                deliveredSet.add(originalIdx);
              }
            });

            // Compter les jobs
            const delivered = result.routes[0].steps.filter(s => s.type === 'job').length;
            const requested = chunk.length;
            if (delivered < requested) {
              console.warn(`ORS n'a livré que ${delivered}/${requested} adresses du chunk`);
            }
          }
        } catch (err) {
          failedRoutesCount++;
        }
      }

      if (i < clusters.length - 1) await this.sleep(1500);
    }

    // Résultats et statistiques
    const delivered = Array.from(deliveredSet).sort((a, b) => a - b);
    const undelivered = adresses
      .map((_, idx) => idx)
      .filter(idx => !deliveredSet.has(idx));

    const stats = {
      totalAddresses: adresses.length,
      deliveredCount: delivered.length,
      undeliveredCount: undelivered.length,
      successRate: adresses.length > 0 ? (delivered.length / adresses.length) * 100 : 0,
      totalRoutes: results.length,
      failedRoutes: failedRoutesCount,
    };

    return { results, delivered, undelivered, stats };
  }

  // CLUSTERING GÉOGRAPHIQUE BASÉ SUR LES DURÉES RÉELLES (K-Medoids)
  private durationKMedoids(
    points: IndexedAddress[],
    k: number,
    maxTimePerVehicule: number,
    durations: number[][],
    parkingIdx: number,
    maxIter = 50
  ): IndexedAddress[][] {
    if (points.length === 0) return [];
    k = Math.min(k, points.length);

    const n = points.length;
    const idxs = points.map(p => p.idx);

    // Etape 1 : initialisation K-Medoids++
    // On choisit le 1er medoïde = point le plus proche du parking
    const medoids: number[] = [];
    const first = idxs.reduce((best, idx) =>
      durations[parkingIdx][addrToMatrix(idx)] < durations[parkingIdx][addrToMatrix(best)] ? idx : best,
      idxs[0]
    );
    medoids.push(first);

    // Les suivants : chaque point est choisi proportionnellement
    // à sa distance (durée) au medoïde le plus proche déjà choisi
    while (medoids.length < k) {
      const weights = idxs.map(idx => {
        const minDur = Math.min(
          ...medoids.map(m => durations[addrToMatrix(m)][addrToMatrix(idx)])
        );
        return minDur * minDur;
      });

      const total = weights.reduce((s, w) => s + w, 0);
      let rand = Math.random() * total;
      let chosen = idxs[idxs.length - 1];

      for (let i = 0; i < idxs.length; i++) {
        rand -= weights[i];
        if (rand <= 0) {
          chosen = idxs[i];
          break;
        }
      }

      if (!medoids.includes(chosen)) medoids.push(chosen);
    }

    // Étape 2 : itérations K-Medoids
    let assignments: number[] = new Array(n).fill(0);

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;

      // Assignation : chaque point va au medoïde le plus proche (en durée)
      for (let pi = 0; pi < n; pi++) {
        let best = 0;
        let bestDur = Infinity;

        for (let mi = 0; mi < medoids.length; mi++) {
          const d = durations[addrToMatrix(points[pi].idx)][addrToMatrix(medoids[mi])];
          if (d < bestDur) {
            bestDur = d;
            best = mi;
          }
        }

        if (assignments[pi] !== best) {
          assignments[pi] = best;
          changed = true;
        }
      }

      if (!changed) {
        console.log(` durationKMedoids convergé en ${iter} itérations`);
        break;
      }

      // Mise à jour : nouveau medoïde = point qui minimise
      // la somme des durées vers tous les autres membres du cluster
      for (let mi = 0; mi < medoids.length; mi++) {
        const members = points.filter((_, pi) => assignments[pi] === mi);
        if (members.length === 0) continue;

        let bestMedoid = medoids[mi];
        let bestCost = Infinity;

        for (const candidate of members) {
          const cost = members.reduce((sum, other) =>
            sum + durations[addrToMatrix(candidate.idx)][addrToMatrix(other.idx)],
            0
          );

          if (cost < bestCost) {
            bestCost = cost;
            bestMedoid = candidate.idx;
          }
        }

        if (bestMedoid !== medoids[mi]) {
          medoids[mi] = bestMedoid;
        }
      }
    }

    // Etape 3 : construire les clusters
    const clusters: IndexedAddress[][] = Array.from({ length: medoids.length }, () => []);
    for (let pi = 0; pi < n; pi++) clusters[assignments[pi]].push(points[pi]);

    // garantit que chaque cluster ≤ 50
    this.rebalanceClusters(clusters, 50, durations);

    return clusters.filter(c => c.length > 0);
  }

  private geoDistanceSq(
    a: { lat: number; lng: number },
    b: { lat: number; lng: number }
  ): number {
    const dlat = a.lat - b.lat;
    const dlng = a.lng - b.lng;
    return dlat * dlat + dlng * dlng;
  }

  // Transfère les adresses en excès vers d'autres clusters géographiquement proches
  private rebalanceClusters(
    clusters: IndexedAddress[][],
    maxSize: number,
    durations?: number[][]
  ): void {
    for (let i = 0; i < clusters.length; i++) {
      while (clusters[i].length > maxSize) {
        const addr = clusters[i].pop()!;
        let bestCluster = -1;
        let bestDist = Infinity;

        for (let j = 0; j < clusters.length; j++) {
          if (j === i || clusters[j].length >= maxSize) continue;

          const d = durations
            // Durée moyenne vers les membres du cluster cible
            ? clusters[j].reduce((sum, member) =>
                sum + durations[addrToMatrix(addr.idx)][addrToMatrix(member.idx)],
                0
              ) / (clusters[j].length || 1)
            // Fallback GPS si pas de matrice
            : this.geoDistanceSq(addr.address, this.clusterCenter(clusters[j]));

          if (d < bestDist) {
            bestDist = d;
            bestCluster = j;
          }
        }

        if (bestCluster === -1) {
          clusters.push([addr]);
        } else {
          clusters[bestCluster].push(addr);
        }
      }
    }
  }

  private clusterCenter(cluster: IndexedAddress[]): { lat: number; lng: number } {
    if (cluster.length === 0) return { lat: 0, lng: 0 };
    return {
      lat: cluster.reduce((s, p) => s + p.address.lat, 0) / cluster.length,
      lng: cluster.reduce((s, p) => s + p.address.lng, 0) / cluster.length,
    };
  }

  // UTILITAIRES
  private chunkArray<T>(arr: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}