import { inject, Injectable } from '@angular/core';
import { Adresse } from '../data/adresse';
import { LatLngLiteral, LatLngTuple } from 'leaflet';
import { unparse } from "papaparse";
import { extractAdressesFromApiGouvResponseString } from '../utils/extractAdressesFromApiGouvResponseString';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { orsKey } from './orsKey';
import { OptimizationResult, parseOptimizationResultP, RouteStepBase } from './OptimizationResult';
import { GeoJSONFeatureCollectionSchema, GeoJSONLineStringSchema } from 'zod-geojson';

const cartoURL = 'https://api-adresse.data.gouv.fr';

// ============================================================
//  TYPES INTERNES
// ============================================================

interface IndexedAddress {
  address: Adresse;
  /** Index 0-based dans le tableau adresses[] passé à optimizeAdvanced */
  idx: number;
}

export interface OptimizationAdvancedResult {
  results: OptimizationResult[];
  delivered: number[];        // indices des adresses livrées
  undelivered: number[];      // indices des adresses NON livrées
  stats: {
    totalAddresses: number;
    deliveredCount: number;
    undeliveredCount: number;
    successRate: number;      // pourcentage (0-100)
    totalRoutes: number;
    failedRoutes: number;
  };
}

/**
 * CONVENTION MATRICE — valable pour 50, 100, 400 adresses ou plus :
 *
 *   La matrice est générée sur [...adresses_livraison, parking]
 *   donc :
 *     adresses[i]  →  matrice[i]              (i = 0 .. n-1)
 *     parking      →  matrice[n]  = matrice[adresses.length]
 *
 *   parkingIdx est calculé dynamiquement à chaque appel :
 *     parkingIdx = adresses.length
 *
 *   addrToMatrix(idx) = idx  (identité, pas de décalage)
 */
const addrToMatrix = (idx: number): number => idx;

@Injectable({
  providedIn: 'root',
})
export class Carto {
  private readonly _httpClient = inject(HttpClient);

  // ============================================================
  //  API PUBLIQUES
  // ============================================================

  public getAdressesFromCoordinates(L: readonly LatLngLiteral[]): Promise<readonly Adresse[]> {
    const url = new URL(cartoURL + '/reverse/csv');
    const formData = new FormData();
    const csvContent = unparse([...L], { delimiter: ';' });
    const csvBlob = new Blob([csvContent], { type: 'text/csv' });
    formData.append("lon", "lng");
    formData.append("columns", "lat");
    formData.append("data", csvBlob);
    const req$ = this._httpClient.post(url.toString(), formData, { responseType: 'text' });
    return firstValueFrom(req$).then(extractAdressesFromApiGouvResponseString);
  }

  public optimize(params: Readonly<{
    nbVehicules: number;
    maxTimePerVehicule: number;
    adresses: readonly Adresse[];
    parking: Adresse;
  }>): Promise<OptimizationResult> {
    const { nbVehicules, maxTimePerVehicule, adresses, parking } = params;
    const parkingLngLat: [number, number] = [parking.lng, parking.lat];
    const LVehicules = Array.from({ length: nbVehicules }, (_, i) => ({
      id: i + 1,
      profile: "driving-car",
      start: parkingLngLat,
      end: parkingLngLat,
      max_travel_time: maxTimePerVehicule,
    }));
    const Ljobs = adresses.map((a, i) => ({
      id: i,
      location: [a.lng, a.lat],
      setup: 30,
      service: 300,
    }));
    const req$ = this._httpClient.post(
      'https://api.openrouteservice.org/optimization',
      { jobs: Ljobs, vehicles: LVehicules },
      { headers: { Authorization: orsKey } }
    );
    return firstValueFrom(req$).then(parseOptimizationResultP);
  }

  public getDirections(lngLatCoordinates: readonly RouteStepBase['location'][]): Promise<ReadonlyArray<LatLngTuple>> {
    const req$ = this._httpClient.post(
      'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
      { coordinates: lngLatCoordinates },
      { headers: { Authorization: orsKey } }
    );
    return firstValueFrom(req$)
      .then(res => GeoJSONFeatureCollectionSchema.parseAsync(res))
      .then(fc => Promise.all(fc.features.map(f => GeoJSONLineStringSchema.parseAsync(f.geometry))))
      .then(Lgeojson => Lgeojson.flatMap(geojson => geojson.coordinates.map(geoJsonLngLatToLatLng)));
  }

  // ============================================================
  //  OPTIMIZE ADVANCED
  // ============================================================

  /**
   * Fonctionne pour n'importe quelle taille de dataset (50, 100, 400...).
   *
   * Stratégie simplifiée :
   *  1. Clustering basé sur les durées réelles → clusters temporellement compacts
   *  2. Appel ORS par cluster qui fait l'optimisation complète
   *  3. Tracking des adresses livrées vs non livrées
   */
  public async optimizeAdvanced(params: {
    nbVehicules: number;
    maxTimePerVehicule: number;
    adresses: readonly Adresse[];
    parking: Adresse;
    preCalculatedMatrix?: { distances: number[][]; durations: number[][] };
  }): Promise<OptimizationAdvancedResult> {
    const { nbVehicules, maxTimePerVehicule, adresses, parking, preCalculatedMatrix } = params;

    // parkingIdx = adresses.length → dynamique, valable pour 50, 100, 400...
    const parkingIdx = adresses.length;

    console.log(`🚀 optimizeAdvanced: ${adresses.length} adresses, ${nbVehicules} véhicules`);
    console.log(`📍 Index parking dans la matrice : ${parkingIdx}`);

    // ── Étape 1 : récupération de la matrice ──────────────────
    let dist: number[][];
    let dur: number[][];

    if (preCalculatedMatrix) {
      dist = preCalculatedMatrix.distances;
      dur  = preCalculatedMatrix.durations;
      console.log(`✅ Matrice pré-calculée (${dist.length}×${dist[0]?.length})`);

      // Vérification : la matrice doit faire (n+1) × (n+1)
      const expected = adresses.length + 1;
      if (dist.length !== expected || dist[0]?.length !== expected) {
        throw new Error(
          `❌ Matrice ${dist.length}×${dist[0]?.length} incohérente avec ${adresses.length} adresses de livraison.\n` +
          `   Attendu : ${expected}×${expected}  (${adresses.length} livraisons + 1 parking en dernière position)`
        );
      }
    } else {
      // Génère la matrice sur [...adresses, parking] → parking toujours en dernière position
      const m = await this.getDistanceMatrix([...adresses, parking]);
      dist = m.distances;
      dur  = m.durations;
    }

    // ── Étape 2 : clustering basé sur les durées ──────────────
    console.log('🗺️  Étape 2 : clustering basé sur les durées réelles...');
    const indexed: IndexedAddress[] = adresses.map((address, idx) => ({ address, idx }));
    const clusters = this.durationKMedoids(indexed, nbVehicules, maxTimePerVehicule, dur, parkingIdx);
    console.log('Tailles des clusters :', clusters.map(c => c.length));

    // Validation : vérifier si les clusters semblent faisables
    for (let i = 0; i < clusters.length; i++) {
      const clusterIdxs = clusters[i].map(p => p.idx);
      const estimatedTime = this.estimateClusterTime(clusterIdxs, dur, parkingIdx);
      if (estimatedTime > maxTimePerVehicule * 1.2) {
        console.warn(`⚠️ Cluster ${i + 1} : temps estimé ${Math.round(estimatedTime)}s > limite ${maxTimePerVehicule}s`);
      }
    }

    // ── Étape 3 : appel ORS par cluster + tracking ────────────
    console.log('📡 Étape 3 : appel ORS par cluster...');
    const results: OptimizationResult[] = [];
    const deliveredSet = new Set<number>();
    let failedRoutesCount = 0;

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      if (cluster.length === 0) continue;

      const clusterAddresses = cluster.map(p => adresses[p.idx]);
      console.log(`  Cluster ${i + 1}/${clusters.length} → ${clusterAddresses.length} adresses`);

      // Split si > 50 (sécurité API ORS)
      const chunks = this.chunkArray(clusterAddresses, 50);
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const chunkOriginalIndices = cluster
          .slice(chunkIdx * 50, (chunkIdx + 1) * 50)
          .map(p => p.idx);

        try {
          const result = await this.optimize({
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

            // Compter les jobs (exclure start et end)
            const delivered = result.routes[0].steps.filter(s => s.type === 'job').length;
            const requested = chunk.length;
            if (delivered < requested) {
              console.warn(`⚠️ ORS n'a livré que ${delivered}/${requested} adresses du chunk`);
            }
          }
        } catch (err) {
          console.error(`❌ ORS error cluster ${i + 1}, chunk ${chunkIdx + 1}:`, err);
          failedRoutesCount++;
        }
      }

      if (i < clusters.length - 1) await this.sleep(1500);
    }

    // ── Résultats et statistiques ─────────────────────────────
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

    console.log('\n📊 Résultats :');
    console.log(`  ✅ Livrées : ${stats.deliveredCount}/${stats.totalAddresses} (${stats.successRate.toFixed(1)}%)`);
    console.log(`  ❌ Non livrées : ${stats.undeliveredCount}`);
    console.log(`  🚗 Routes créées : ${stats.totalRoutes}`);
    if (stats.failedRoutes > 0) {
      console.log(`  ⚠️ Routes échouées : ${stats.failedRoutes}`);
    }

    if (undelivered.length > 0) {
      console.warn(`\n⚠️ Adresses non livrées (indices) : ${undelivered.slice(0, 10).join(', ')}${undelivered.length > 10 ? '...' : ''}`);
      
      // Estimation si faisable
      const minTimeNeeded = this.estimateMinimumTimeForAll(adresses, dur, parkingIdx);
      const maxTimeAvailable = nbVehicules * maxTimePerVehicule;
      if (minTimeNeeded > maxTimeAvailable) {
        console.warn(`\n💡 Suggestions :`);
        console.warn(`  - Augmenter nbVehicules à ${Math.ceil(minTimeNeeded / maxTimePerVehicule)}`);
        console.warn(`  - Ou augmenter maxTimePerVehicule à ${Math.ceil(minTimeNeeded / nbVehicules)}s`);
      }
    }

    return { results, delivered, undelivered, stats };
  }

  // ============================================================
  //  CLUSTERING GÉOGRAPHIQUE (K-MEANS GPS)
  // ============================================================

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
  const idxs = points.map(p => p.idx); // indices dans la matrice

  // ── Étape 1 : initialisation K-Medoids++ ──────────────────
  // On choisit le 1er medoïde = point le plus proche du parking
  const medoids: number[] = [];
  const first = idxs.reduce((best, idx) =>
    durations[parkingIdx][addrToMatrix(idx)] < durations[parkingIdx][addrToMatrix(best)]
      ? idx : best,
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
      return minDur * minDur; // distance² → favorise les points éloignés
    });

    const total = weights.reduce((s, w) => s + w, 0);
    let rand = Math.random() * total;
    let chosen = idxs[idxs.length - 1];
    for (let i = 0; i < idxs.length; i++) {
      rand -= weights[i];
      if (rand <= 0) { chosen = idxs[i]; break; }
    }
    if (!medoids.includes(chosen)) medoids.push(chosen);
  }

  // ── Étape 2 : itérations K-Medoids ────────────────────────
  let assignments: number[] = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // Assignation : chaque point va au medoïde le plus proche (en durée)
    for (let pi = 0; pi < n; pi++) {
      let best = 0;
      let bestDur = Infinity;
      for (let mi = 0; mi < medoids.length; mi++) {
        const d = durations[addrToMatrix(points[pi].idx)][addrToMatrix(medoids[mi])];
        if (d < bestDur) { bestDur = d; best = mi; }
      }
      if (assignments[pi] !== best) { assignments[pi] = best; changed = true; }
    }

    if (!changed) {
      console.log(`  durationKMedoids convergé en ${iter} itérations`);
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
          sum + durations[addrToMatrix(candidate.idx)][addrToMatrix(other.idx)], 0
        );
        if (cost < bestCost) { bestCost = cost; bestMedoid = candidate.idx; }
      }

      if (bestMedoid !== medoids[mi]) {
        medoids[mi] = bestMedoid;
        // changed reste true → une nouvelle itération sera lancée
      }
    }
  }

  // ── Étape 3 : construire les clusters ─────────────────────
  const clusters: IndexedAddress[][] = Array.from({ length: medoids.length }, () => []);
  for (let pi = 0; pi < n; pi++) clusters[assignments[pi]].push(points[pi]);

  // Rééquilibrage : garantit que chaque cluster ≤ 50 (limite ORS)
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

  /** Transfère les adresses en excès vers d'autres clusters géographiquement proches */
  private rebalanceClusters(
  clusters: IndexedAddress[][],
  maxSize: number,
  durations?: number[][]   // optionnel : si fourni, utilise les durées
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
              sum + durations[addrToMatrix(addr.idx)][addrToMatrix(member.idx)], 0
            ) / (clusters[j].length || 1)
          // Fallback GPS si pas de matrice
          : this.geoDistanceSq(addr.address, this.clusterCenter(clusters[j]));

        if (d < bestDist) { bestDist = d; bestCluster = j; }
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

  // ============================================================
  //  VALIDATION ET ESTIMATION
  // ============================================================

  /**
   * Estime le temps minimum pour un cluster (ordre naïf : parking → points dans l'ordre → parking)
   */
  private estimateClusterTime(idxs: number[], durations: number[][], parkingIdx: number): number {
    if (idxs.length === 0) return 0;
    const SETUP = 30, SERVICE = 300;
    
    // Simplification : temps = parking → premier + somme des segments + dernier → parking + services
    let time = durations[parkingIdx][addrToMatrix(idxs[0])] + SETUP + SERVICE;
    for (let i = 1; i < idxs.length; i++) {
      time += durations[addrToMatrix(idxs[i - 1])][addrToMatrix(idxs[i])] + SETUP + SERVICE;
    }
    time += durations[addrToMatrix(idxs[idxs.length - 1])][parkingIdx];
    return time;
  }

  /**
   * Estime le temps minimum total nécessaire pour toutes les adresses
   */
  private estimateMinimumTimeForAll(adresses: readonly Adresse[], durations: number[][], parkingIdx: number): number {
    const SETUP = 30, SERVICE = 300;
    const n = adresses.length;
    
    // Temps = somme des services + estimation de trajet
    // (approximation : diamètre du nuage de points)
    let maxDuration = 0;
    for (let i = 0; i < n; i++) {
      const toPark = durations[addrToMatrix(i)][parkingIdx];
      const fromPark = durations[parkingIdx][addrToMatrix(i)];
      maxDuration = Math.max(maxDuration, toPark, fromPark);
    }
    
    // Estimation conservatrice : 2× diamètre + tous les services
    return maxDuration * 2 + n * (SETUP + SERVICE);
  }

  // ============================================================
  //  UTILITAIRES
  // ============================================================

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================
  //  MATRICE DE DISTANCES
  // ============================================================

  public async getDistanceMatrix(adresses: readonly Adresse[]): Promise<{
    distances: number[][];
    durations: number[][];
    sources: Array<{ location: [number, number]; snapped_distance: number }>;
    destinations: Array<{ location: [number, number]; snapped_distance: number }>;
    metadata?: any;
  }> {
    const maxLocationsPerRequest = 50;
    const totalAddresses = adresses.length;

    if (totalAddresses <= maxLocationsPerRequest) {
      const locations = adresses.map(a => [a.lng, a.lat]);
      const req$ = this._httpClient.post(
        'https://api.openrouteservice.org/v2/matrix/driving-car',
        { locations, metrics: ['distance', 'duration'] },
        { headers: { Authorization: orsKey } }
      );
      const result = await firstValueFrom(req$) as any;
      return {
        distances: result.distances || [],
        durations: result.durations || [],
        sources: result.sources || [],
        destinations: result.destinations || [],
        metadata: result.metadata
      };
    }

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const fullDistanceMatrix: number[][] = Array(totalAddresses).fill(null).map(() => Array(totalAddresses).fill(0));
    const fullDurationMatrix: number[][] = Array(totalAddresses).fill(null).map(() => Array(totalAddresses).fill(0));
    const allSources: Array<{ location: [number, number]; snapped_distance: number }> =
      Array(totalAddresses).fill(null).map(() => ({ location: [0, 0] as [number, number], snapped_distance: 0 }));
    const allDestinations: Array<{ location: [number, number]; snapped_distance: number }> =
      Array(totalAddresses).fill(null).map(() => ({ location: [0, 0] as [number, number], snapped_distance: 0 }));

    const numChunks = Math.ceil(totalAddresses / maxLocationsPerRequest);
    let requestCount = 0;
    const totalRequests = numChunks * numChunks;
    let lastMetadata: any = null;
    const MIN_DELAY_MS = (60 * 1000) / 30;

    for (let i = 0; i < numChunks; i++) {
      for (let j = 0; j < numChunks; j++) {
        requestCount++;
        const startTime = Date.now();
        console.log(`📡 Request ${requestCount}/${totalRequests}...`);

        const startI = i * maxLocationsPerRequest;
        const endI   = Math.min((i + 1) * maxLocationsPerRequest, totalAddresses);
        const startJ = j * maxLocationsPerRequest;
        const endJ   = Math.min((j + 1) * maxLocationsPerRequest, totalAddresses);

        const sourceAddresses = adresses.slice(startI, endI);
        const destAddresses   = adresses.slice(startJ, endJ);
        const allLocations    = [
          ...sourceAddresses.map(a => [a.lng, a.lat]),
          ...destAddresses.map(a => [a.lng, a.lat])
        ];
        const sources      = Array.from({ length: sourceAddresses.length }, (_, idx) => idx);
        const destinations = Array.from({ length: destAddresses.length }, (_, idx) => idx + sourceAddresses.length);

        const req$ = this._httpClient.post(
          'https://api.openrouteservice.org/v2/matrix/driving-car',
          { locations: allLocations, sources, destinations, metrics: ['distance', 'duration'] },
          { headers: { Authorization: orsKey } }
        );

        let retries = 0;
        let success = false;
        while (!success && retries <= 3) {
          try {
            const result = await firstValueFrom(req$) as any;
            if (result.metadata) lastMetadata = result.metadata;
            for (let li = 0; li < result.distances.length; li++) {
              for (let lj = 0; lj < result.distances[li].length; lj++) {
                fullDistanceMatrix[startI + li][startJ + lj] = result.distances[li][lj];
                fullDurationMatrix[startI + li][startJ + lj] = result.durations[li][lj];
              }
            }
            for (let li = 0; li < result.sources.length; li++) allSources[startI + li] = result.sources[li];
            for (let lj = 0; lj < result.destinations.length; lj++) allDestinations[startJ + lj] = result.destinations[lj];
            success = true;
          } catch (error: any) {
            if (error.status === 429 && retries < 3) {
              retries++;
              await sleep(Math.pow(2, retries) * 3000);
            } else { throw error; }
          }
        }

        if (requestCount < totalRequests) {
          const elapsed = Date.now() - startTime;
          const wait = Math.max(MIN_DELAY_MS - elapsed, 0);
          if (wait > 0) await sleep(wait);
        }
      }
    }

    return {
      distances: fullDistanceMatrix,
      durations: fullDurationMatrix,
      sources: allSources,
      destinations: allDestinations,
      metadata: lastMetadata
    };
  }
}

export function geoJsonLngLatToLatLng(lngLat: number[]): LatLngTuple {
  return [lngLat[1], lngLat[0]];
}