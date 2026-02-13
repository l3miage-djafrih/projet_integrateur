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
   * Stratégie :
   *  1. Clustering géographique GPS → clusters géographiquement compacts
   *  2. Nearest-Neighbor pour construire l'ordre initial de chaque cluster
   *  3. 2-opt pour améliorer chaque route localement
   *  4. Inter-route relocation : déplace des adresses entre routes pour réduire le coût total
   *  5. Appel ORS par cluster (1 véhicule, ≤ 50 adresses par appel)
   */
  public async optimizeAdvanced(params: {
    nbVehicules: number;
    maxTimePerVehicule: number;
    adresses: readonly Adresse[];
    parking: Adresse;
    preCalculatedMatrix?: { distances: number[][]; durations: number[][] };
  }): Promise<OptimizationResult[]> {
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

    // ── Étape 2 : clustering géographique ─────────────────────
    console.log('🗺️  Étape 2 : clustering géographique...');
    const indexed: IndexedAddress[] = adresses.map((address, idx) => ({ address, idx }));
    const clusters = this.geoKMeans(indexed, nbVehicules, maxTimePerVehicule, dur, parkingIdx);
    console.log('Tailles des clusters :', clusters.map(c => c.length));

    // ── Étape 3 : nearest-neighbor + 2-opt ────────────────────
    console.log('⚡ Étape 3 : NN + 2-opt par cluster...');
    let routes: number[][] = clusters.map(cluster => {
      const idxs = cluster.map(p => p.idx);
      const nn   = this.nearestNeighborOrder(idxs, dist, parkingIdx);
      return this.twoOptImprove(nn, dist, parkingIdx);
    });

    // ── Étape 4 : inter-route relocation ──────────────────────
    console.log('🔀 Étape 4 : inter-route relocation...');
    routes = this.interRouteRelocation(routes, dist, dur, maxTimePerVehicule, parkingIdx);
    console.log('Tailles finales :', routes.map(r => r.length));

    // ── Étape 5 : appel ORS par cluster ───────────────────────
    console.log('📡 Étape 5 : appel ORS par cluster...');
    const results: OptimizationResult[] = [];

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      if (route.length === 0) continue;

      const routeAddresses = route.map(idx => adresses[idx]);
      console.log(`  Route ${i + 1}/${routes.length} → ${routeAddresses.length} adresses`);

      // Split si > 50 (sécurité, ne devrait pas arriver grâce au rebalanceClusters)
      const chunks = this.chunkArray(routeAddresses, 50);
      for (const chunk of chunks) {
        try {
          const result = await this.optimize({
            nbVehicules: 1,
            maxTimePerVehicule,
            adresses: chunk,
            parking,
          });
          results.push(result);
        } catch (err) {
          console.error(`❌ ORS error route ${i + 1}:`, err);
        }
      }

      if (i < routes.length - 1) await this.sleep(1500);
    }

    console.log(`✅ ${results.length} routes optimisées.`);
    return results;
  }

  // ============================================================
  //  CLUSTERING GÉOGRAPHIQUE (K-MEANS GPS)
  // ============================================================

  private geoKMeans(
    points: IndexedAddress[],
    k: number,
    maxTimePerVehicule: number,
    durations: number[][],
    parkingIdx: number,
    maxIter = 50
  ): IndexedAddress[][] {
    if (points.length === 0) return [];
    k = Math.min(k, points.length);

    // Initialisation : points uniformément répartis triés par longitude
    const sorted = [...points].sort((a, b) => a.address.lng - b.address.lng);
    const step = Math.ceil(sorted.length / k);
    let centroids: { lat: number; lng: number }[] = Array.from({ length: k }, (_, i) => {
      const seed = sorted[Math.min(i * step, sorted.length - 1)];
      return { lat: seed.address.lat, lng: seed.address.lng };
    });

    let assignments: number[] = new Array(points.length).fill(0);

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;

      // Assignation : chaque point va au centroïd le plus proche
      for (let pi = 0; pi < points.length; pi++) {
        let best = 0;
        let bestD = Infinity;
        for (let ci = 0; ci < k; ci++) {
          const d = this.geoDistanceSq(points[pi].address, centroids[ci]);
          if (d < bestD) { bestD = d; best = ci; }
        }
        if (assignments[pi] !== best) { assignments[pi] = best; changed = true; }
      }

      if (!changed) {
        console.log(`  geoKMeans convergé en ${iter} itérations`);
        break;
      }

      // Mise à jour : centroïd = moyenne géométrique du cluster
      const sums = Array.from({ length: k }, () => ({ lat: 0, lng: 0, count: 0 }));
      for (let pi = 0; pi < points.length; pi++) {
        const c = assignments[pi];
        sums[c].lat += points[pi].address.lat;
        sums[c].lng += points[pi].address.lng;
        sums[c].count++;
      }
      centroids = sums.map((s, ci) =>
        s.count > 0
          ? { lat: s.lat / s.count, lng: s.lng / s.count }
          : centroids[ci]
      );
    }

    // Construire les clusters
    const clusters: IndexedAddress[][] = Array.from({ length: k }, () => []);
    for (let pi = 0; pi < points.length; pi++) clusters[assignments[pi]].push(points[pi]);

    // Rééquilibrage : garantit que chaque cluster ≤ 50 (limite ORS)
    this.rebalanceClusters(clusters, 50);

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
  private rebalanceClusters(clusters: IndexedAddress[][], maxSize: number): void {
    for (let i = 0; i < clusters.length; i++) {
      while (clusters[i].length > maxSize) {
        const addr = clusters[i].pop()!;
        let bestCluster = -1;
        let bestDist = Infinity;
        for (let j = 0; j < clusters.length; j++) {
          if (j === i || clusters[j].length >= maxSize) continue;
          const d = this.geoDistanceSq(addr.address, this.clusterCenter(clusters[j]));
          if (d < bestDist) { bestDist = d; bestCluster = j; }
        }
        if (bestCluster === -1) {
          clusters.push([addr]); // tous les clusters sont pleins : crée un nouveau
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
  //  NEAREST NEIGHBOR HEURISTIC
  // ============================================================

  private nearestNeighborOrder(
    idxs: number[],
    distances: number[][],
    parkingIdx: number
  ): number[] {
    if (idxs.length <= 1) return [...idxs];

    const unvisited = new Set(idxs);
    const route: number[] = [];

    // Démarre par le point le plus proche du parking
    let current = idxs.reduce((best, idx) =>
      distances[parkingIdx][addrToMatrix(idx)] < distances[parkingIdx][addrToMatrix(best)]
        ? idx : best,
      idxs[0]
    );

    while (unvisited.size > 0) {
      unvisited.delete(current);
      route.push(current);
      if (unvisited.size === 0) break;

      let nearestIdx = -1;
      let nearestDist = Infinity;
      for (const next of unvisited) {
        const d = distances[addrToMatrix(current)][addrToMatrix(next)];
        if (d < nearestDist) { nearestDist = d; nearestIdx = next; }
      }
      current = nearestIdx;
    }

    return route;
  }

  // ============================================================
  //  2-OPT
  // ============================================================

  private twoOptImprove(route: number[], distances: number[][], parkingIdx: number): number[] {
    if (route.length < 4) return route;
    let best = [...route];
    let improved = true;
    let iter = 0;
    while (improved && iter++ < 100) {
      improved = false;
      for (let i = 0; i < best.length - 2; i++) {
        for (let j = i + 2; j < best.length; j++) {
          const candidate = this.twoOptSwap(best, i, j);
          if (this.routeCost(candidate, distances, parkingIdx) < this.routeCost(best, distances, parkingIdx)) {
            best = candidate;
            improved = true;
          }
        }
      }
    }
    return best;
  }

  private twoOptSwap(route: number[], i: number, j: number): number[] {
    return [
      ...route.slice(0, i + 1),
      ...route.slice(i + 1, j + 1).reverse(),
      ...route.slice(j + 1),
    ];
  }

  // ============================================================
  //  INTER-ROUTE RELOCATION
  // ============================================================

  private interRouteRelocation(
    routes: number[][],
    distances: number[][],
    durations: number[][],
    maxTime: number,
    parkingIdx: number,
    maxIter = 30
  ): number[][] {
    let best = routes.map(r => [...r]);
    let improved = true;
    let iter = 0;

    while (improved && iter++ < maxIter) {
      improved = false;
      outer:
      for (let i = 0; i < best.length; i++) {
        for (let ci = 0; ci < best[i].length; ci++) {
          const client = best[i][ci];
          for (let j = 0; j < best.length; j++) {
            if (j === i || best[j].length >= 50) continue;
            for (let pos = 0; pos <= best[j].length; pos++) {
              const newI = [...best[i].slice(0, ci), ...best[i].slice(ci + 1)];
              const newJ = [...best[j].slice(0, pos), client, ...best[j].slice(pos)];
              if (this.routeTime(newJ, durations, parkingIdx) > maxTime) continue;
              const oldCost =
                this.routeCost(best[i], distances, parkingIdx) +
                this.routeCost(best[j], distances, parkingIdx);
              const newCost =
                this.routeCost(newI, distances, parkingIdx) +
                this.routeCost(newJ, distances, parkingIdx);
              if (newCost < oldCost - 1) {
                best[i] = newI;
                best[j] = newJ;
                improved = true;
                break outer;
              }
            }
          }
        }
      }
    }

    console.log(`  interRouteRelocation: ${iter} itérations`);
    return best.filter(r => r.length > 0);
  }

  // ============================================================
  //  COÛT ET TEMPS DE ROUTE
  // ============================================================

  private routeCost(route: number[], distances: number[][], parkingIdx: number): number {
    if (route.length === 0) return 0;
    let cost = distances[parkingIdx][addrToMatrix(route[0])];
    for (let i = 1; i < route.length; i++) {
      cost += distances[addrToMatrix(route[i - 1])][addrToMatrix(route[i])];
    }
    cost += distances[addrToMatrix(route[route.length - 1])][parkingIdx];
    return cost;
  }

  private routeTime(route: number[], durations: number[][], parkingIdx: number): number {
    if (route.length === 0) return 0;
    const SETUP = 30, SERVICE = 300;
    let time = durations[parkingIdx][addrToMatrix(route[0])] + SETUP + SERVICE;
    for (let i = 1; i < route.length; i++) {
      time += durations[addrToMatrix(route[i - 1])][addrToMatrix(route[i])] + SETUP + SERVICE;
    }
    time += durations[addrToMatrix(route[route.length - 1])][parkingIdx];
    return time;
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