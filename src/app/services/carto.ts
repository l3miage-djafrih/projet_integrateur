import { inject, Injectable } from '@angular/core';
import { Adresse } from '../data/adresse';
import { LatLng, LatLngLiteral, LatLngTuple } from 'leaflet';
import { unparse } from "papaparse";
import { extractAdressesFromApiGouvResponseString } from '../utils/extractAdressesFromApiGouvResponseString';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { orsKey } from './orsKey';
import { OptimizationResult, parseOptimizationResultP, RouteStepBase } from './OptimizationResult';
import { GeoJSONFeatureCollectionSchema, GeoJSONLineStringSchema } from 'zod-geojson';
import * as turf from '@turf/turf';

const cartoURL = 'https://api-adresse.data.gouv.fr';

@Injectable({
  providedIn: 'root',
})
export class Carto {
  private readonly _httpClient = inject(HttpClient);

  /**
   * Gouv.api Reverse geocoding: from coordinates to addresses.
   */
  public getAdressesFromCoordinates(L: readonly LatLngLiteral[]): Promise<readonly Adresse[]> {
    const url = new URL(cartoURL + '/reverse/csv');
    const formData = new FormData();
    const csvContent = unparse([...L], { delimiter: ';' });
    const csvBlob = new Blob([csvContent], {
      type: 'text/csv'
    });
    formData.append("lon", "lng");
    formData.append("columns", "lat");
    formData.append("data", csvBlob);

    const req$ = this._httpClient.post(url.toString(), formData, { responseType: 'text' });
    
    return firstValueFrom(req$).then(
      extractAdressesFromApiGouvResponseString
    )
  }

  /**
   * OpenRouteService Optimization API call.
   */
  public optimize(params: Readonly<{
    nbVehicules: number,
    maxTimePerVehicule: number,
    adresses: readonly Adresse[],
    parking: Adresse
  }>): Promise<OptimizationResult> {
    const { nbVehicules, maxTimePerVehicule, adresses, parking } = params;
    const parkingLngLat: [number, number] = [parking.lng, parking.lat];
    const LVehicules = Array.from(
      { length: nbVehicules },
      (_, i) => ({
        id: i + 1,
        profile: "driving-car",
        start: parkingLngLat,
        end: parkingLngLat,
        max_travel_time: maxTimePerVehicule,
      })
    );
    
    const Ljobs = adresses.map(
      (a, i) => ({
        id: i,
        location: [a.lng, a.lat],
        setup: 30,
        service: 300,
      })
    );

    const req$ = this._httpClient.post(
      'https://api.openrouteservice.org/optimization',
      {
        jobs: Ljobs,
        vehicles: LVehicules,
      },
      {
        headers: {
          Authorization: orsKey,
        }
      }
    );

    return firstValueFrom(req$).then(
      parseOptimizationResultP
    );
  }

  /**
   * OpenRouteService direction API call.
   */
  public getDirections(lngLatCoordinates: readonly RouteStepBase['location'][]): Promise<ReadonlyArray<LatLngTuple>> {
    const req$ = this._httpClient.post(
      'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
      {
        coordinates: lngLatCoordinates,
      },
      {
        headers: {
          Authorization: orsKey,
        }
      }
    );

    return firstValueFrom(req$).then(
      res => GeoJSONFeatureCollectionSchema.parseAsync(res)
    ).then(
      fc => Promise.all(
        fc.features.map(f => GeoJSONLineStringSchema.parseAsync(f.geometry))
      )
    ).then(
      Lgeojson => Lgeojson.flatMap(geojson => geojson.coordinates.map(geoJsonLngLatToLatLng))
    )
  }

  /**
   * ============================================================
   * STRATÉGIE ADAPTATIVE POUR LA MATRICE DE DISTANCES
   * ============================================================
   * - <= 50 adresses : Requête directe
   * - 51-100 adresses : Découpage en chunks
   * - > 100 adresses : Clustering adaptatif (rayon → K-means si nécessaire)
   */
  public async getDistanceMatrix(adresses: readonly Adresse[]): Promise<{
    distances: number[][];
    strategy?: string;
    clusters?: Adresse[][];
    clusterCentroids?: Adresse[];
  }> {
    const totalAddresses = adresses.length;

    console.log(`📊 Calculating distance matrix for ${totalAddresses} addresses...`);

    // ========== STRATÉGIE 1 : Direct (<=50) ==========
    if (totalAddresses <= 50) {
      console.log('✅ Strategy: Direct API call');
      const locations = adresses.map(a => [a.lng, a.lat]);
      const req$ = this._httpClient.post(
        'https://api.openrouteservice.org/v2/matrix/driving-car',
        {
          locations: locations,
          metrics: ['distance']
        },
        {
          headers: {
            Authorization: orsKey,
          }
        }
      );

      const result = await firstValueFrom(req$) as { distances: number[][] };
      return { 
        distances: result.distances,
        strategy: 'direct'
      };
    }

    // ========== STRATÉGIE 2 : Chunked (51-100) ==========
    if (totalAddresses <= 100) {
      console.log('✅ Strategy: Chunked requests (2x2 = 4 requests)');
      return {
        distances: (await this.getDistanceMatrixChunked(adresses)).distances,
        strategy: 'chunked'
      };
    }

    // ========== STRATÉGIE 3 : Clustering adaptatif (>100) ==========
    console.log('✅ Strategy: Adaptive clustering');
    return this.getDistanceMatrixAdaptive(adresses);
  }

  /**
   * STRATÉGIE 2 : Découpage en chunks pour 51-100 adresses
   */
  private async getDistanceMatrixChunked(adresses: readonly Adresse[]): Promise<{
    distances: number[][];
  }> {
    const maxLocationsPerRequest = 50;
    const totalAddresses = adresses.length;
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const fullMatrix: number[][] = Array(totalAddresses)
      .fill(null)
      .map(() => Array(totalAddresses).fill(0));

    const numChunks = Math.ceil(totalAddresses / maxLocationsPerRequest);
    
    let requestCount = 0;
    const totalRequests = numChunks * numChunks;

    for (let i = 0; i < numChunks; i++) {
      for (let j = 0; j < numChunks; j++) {
        requestCount++;
        console.log(`  📡 Chunked request ${requestCount}/${totalRequests}...`);

        const startI = i * maxLocationsPerRequest;
        const endI = Math.min((i + 1) * maxLocationsPerRequest, totalAddresses);
        const startJ = j * maxLocationsPerRequest;
        const endJ = Math.min((j + 1) * maxLocationsPerRequest, totalAddresses);

        const sourceAddresses = adresses.slice(startI, endI);
        const destAddresses = adresses.slice(startJ, endJ);

        const allLocations = [
          ...sourceAddresses.map(a => [a.lng, a.lat]),
          ...destAddresses.map(a => [a.lng, a.lat])
        ];

        const sources = Array.from({ length: sourceAddresses.length }, (_, idx) => idx);
        const destinations = Array.from(
          { length: destAddresses.length }, 
          (_, idx) => idx + sourceAddresses.length
        );

        const req$ = this._httpClient.post(
          'https://api.openrouteservice.org/v2/matrix/driving-car',
          {
            locations: allLocations,
            sources: sources,
            destinations: destinations,
            metrics: ['distance']
          },
          {
            headers: {
              Authorization: orsKey,
            }
          }
        );

        try {
          const result = await firstValueFrom(req$) as { distances: number[][] };

          for (let localI = 0; localI < result.distances.length; localI++) {
            for (let localJ = 0; localJ < result.distances[localI].length; localJ++) {
              const globalI = startI + localI;
              const globalJ = startJ + localJ;
              fullMatrix[globalI][globalJ] = result.distances[localI][localJ];
            }
          }

          if (requestCount < totalRequests) {
            await sleep(1500);
          }
        } catch (error) {
          console.error(`❌ Error on chunked request ${requestCount}:`, error);
          throw error;
        }
      }
    }

    console.log('✅ Chunked distance matrix completed!');
    return { distances: fullMatrix };
  }

  /**
   * STRATÉGIE 3 : Clustering adaptatif (>100 adresses)
   * Essaie d'abord clustering par rayon (plus précis)
   * Si trop de clusters, bascule sur K-means
   */
  private async getDistanceMatrixAdaptive(adresses: readonly Adresse[]): Promise<{
    distances: number[][];
    strategy: string;
    clusters: Adresse[][];
    clusterCentroids: Adresse[];
  }> {
    const targetClusters = 45; // Limite pour une seule requête API
    let radius = 300; // Commencer avec un rayon de 300m
    let clusters: Adresse[][] = [];

    // Essayer d'augmenter le rayon jusqu'à avoir <= 45 clusters
    while (radius <= 2000) {
      clusters = this.clusterByRadius(adresses, radius);
      
      console.log(`  🔍 Testing radius ${radius}m → ${clusters.length} clusters`);
      
      if (clusters.length <= targetClusters) {
        console.log(`  ✅ Using radius clustering (${radius}m, ${clusters.length} clusters) - PRECISE`);
        const result = await this.getMatrixFromClusters(adresses, clusters);
        return {
          ...result,
          strategy: `radius-${radius}m-${clusters.length}clusters`,
          clusters,
          clusterCentroids: clusters.map(c => this.getClusterCentroid(c))
        };
      }
      
      radius += 100;
    }

    // Si aucun rayon ne fonctionne, forcer K-means
    console.log(`  ⚠️ Too many clusters with radius, switching to K-means (${targetClusters} clusters)`);
    clusters = this.kMeansClustering(adresses, targetClusters);
    const result = await this.getMatrixFromClusters(adresses, clusters);
    return {
      ...result,
      strategy: `kmeans-${targetClusters}clusters`,
      clusters,
      clusterCentroids: clusters.map(c => this.getClusterCentroid(c))
    };
  }

  /**
   * Clustering par rayon (plus précis)
   */
  private clusterByRadius(
    adresses: readonly Adresse[],
    radiusMeters: number
  ): Adresse[][] {
    const clusters: Adresse[][] = [];
    const visited = new Set<number>();

    for (let i = 0; i < adresses.length; i++) {
      if (visited.has(i)) continue;

      const cluster: Adresse[] = [adresses[i]];
      visited.add(i);

      const point1 = turf.point([adresses[i].lng, adresses[i].lat]);

      for (let j = i + 1; j < adresses.length; j++) {
        if (visited.has(j)) continue;

        const point2 = turf.point([adresses[j].lng, adresses[j].lat]);
        const distance = turf.distance(point1, point2, { units: 'meters' });

        if (distance <= radiusMeters) {
          cluster.push(adresses[j]);
          visited.add(j);
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  /**
   * K-means clustering (quand le rayon ne suffit pas)
   */
  private kMeansClustering(
    adresses: readonly Adresse[],
    k: number
  ): Adresse[][] {
    const points = turf.featureCollection(
      adresses.map((a, i) => turf.point([a.lng, a.lat], { index: i }))
    );
    
    const clustered = turf.clustersKmeans(points, { numberOfClusters: k });
    
    const clusters: Adresse[][] = Array(k).fill(null).map(() => []);
    
    clustered.features.forEach((feature) => {
      const clusterIndex = feature.properties!.cluster;
      const addrIndex = feature.properties!['index'];
      if (clusterIndex !== undefined && addrIndex !== undefined) {
        clusters[clusterIndex].push(adresses[addrIndex]);
      }
    });
    
    return clusters.filter(c => c.length > 0);
  }

  /**
   * Calculer la matrice à partir de clusters
   */
  private async getMatrixFromClusters(
    adresses: readonly Adresse[],
    clusters: Adresse[][]
  ): Promise<{ distances: number[][] }> {
    // Calculer centroïdes
    const centroids = clusters.map(c => this.getClusterCentroid(c));

    console.log(`  📡 Fetching distances between ${centroids.length} cluster centroids...`);

    // Matrice entre centroïdes (récursif, utilisera stratégie 1 ou 2)
    const centroidResult = await this.getDistanceMatrix(centroids);
    const centroidMatrix = centroidResult.distances;

    // Reconstruire matrice complète
    const fullMatrix: number[][] = Array(adresses.length)
      .fill(null)
      .map(() => Array(adresses.length).fill(0));

    // Mapping: index d'adresse → index de cluster
    const addressToCluster: number[] = [];
    for (let clusterIdx = 0; clusterIdx < clusters.length; clusterIdx++) {
      for (const addr of clusters[clusterIdx]) {
        const addrIdx = adresses.indexOf(addr);
        addressToCluster[addrIdx] = clusterIdx;
      }
    }

    // Remplir la matrice complète
    for (let i = 0; i < adresses.length; i++) {
      for (let j = 0; j < adresses.length; j++) {
        const clusterI = addressToCluster[i];
        const clusterJ = addressToCluster[j];

        if (clusterI === clusterJ) {
          // Même cluster = distance euclidienne (vol d'oiseau)
          fullMatrix[i][j] = this.getEuclideanDistance(adresses[i], adresses[j]);
        } else {
          // Différents clusters = distance entre centroïdes (précise)
          fullMatrix[i][j] = centroidMatrix[clusterI][clusterJ];
        }
      }
    }

    console.log(`  ✅ Distance matrix completed!`);
    return { distances: fullMatrix };
  }

  /**
   * Centroïde d'un cluster
   */
  private getClusterCentroid(cluster: Adresse[]): Adresse {
    if (cluster.length === 1) return cluster[0];
    
    const points = turf.featureCollection(
      cluster.map(a => turf.point([a.lng, a.lat]))
    );
    const centroid = turf.center(points);
    
    return {
  ...cluster[0],
  lat: centroid.geometry.coordinates[1],
  lng: centroid.geometry.coordinates[0]
};
  }

  /**
   * Distance euclidienne entre deux adresses (en mètres)
   */
  private getEuclideanDistance(a1: Adresse, a2: Adresse): number {
    const point1 = turf.point([a1.lng, a1.lat]);
    const point2 = turf.point([a2.lng, a2.lat]);
    return turf.distance(point1, point2, { units: 'meters' });
  }
}

/**
 * Convert GeoJSON [lng, lat] to Leaflet [lat, lng]
 */
export function geoJsonLngLatToLatLng(lngLat: number[]): LatLngTuple {
  return [lngLat[1], lngLat[0]];
}