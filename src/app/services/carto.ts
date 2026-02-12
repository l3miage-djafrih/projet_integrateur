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
   * Calcule la matrice de distances routières entre adresses avec métadonnées complètes.
   */
  public async getDistanceMatrix(adresses: readonly Adresse[]): Promise<{
    distances: number[][];
    durations: number[][];
    sources: Array<{ location: [number, number]; snapped_distance: number }>;
    destinations: Array<{ location: [number, number]; snapped_distance: number }>;
    metadata?: any;
  }> {
    const maxLocationsPerRequest = 50;
    const totalAddresses = adresses.length;

    // Si on a 50 adresses ou moins, on fait une seule requête
    if (totalAddresses <= maxLocationsPerRequest) {
      const locations = adresses.map(a => [a.lng, a.lat]);
      const req$ = this._httpClient.post(
        'https://api.openrouteservice.org/v2/matrix/driving-car',
        {
          locations: locations,
          metrics: ['distance', 'duration']
        },
        {
          headers: {
            Authorization: orsKey,
          }
        }
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

    // Pour plus de 50 adresses, vérifier s'il faut utiliser le clustering
    if (totalAddresses > 100) {
      console.warn(`⚠️ ${totalAddresses} addresses detected. Consider using pre-calculated matrix.`);
    }

    // Fonction utilitaire pour attendre
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Initialiser les matrices complètes
    const fullDistanceMatrix: number[][] = Array(totalAddresses)
      .fill(null)
      .map(() => Array(totalAddresses).fill(0));
    
    const fullDurationMatrix: number[][] = Array(totalAddresses)
      .fill(null)
      .map(() => Array(totalAddresses).fill(0));

    const allSources: Array<{ location: [number, number]; snapped_distance: number }> = 
      Array(totalAddresses).fill(null).map(() => ({ location: [0, 0], snapped_distance: 0 }));
    const allDestinations: Array<{ location: [number, number]; snapped_distance: number }> = 
      Array(totalAddresses).fill(null).map(() => ({ location: [0, 0], snapped_distance: 0 }));

    const numChunks = Math.ceil(totalAddresses / maxLocationsPerRequest);
    
    let requestCount = 0;
    const totalRequests = numChunks * numChunks;
    let lastMetadata: any = null;

    const REQUESTS_PER_MINUTE = 30;
    const MIN_DELAY_MS = (60 * 1000) / REQUESTS_PER_MINUTE;

    // Traiter chaque combinaison de chunks
    for (let i = 0; i < numChunks; i++) {
      for (let j = 0; j < numChunks; j++) {
        requestCount++;
        const startTime = Date.now();
        
        console.log(`📡 Processing request ${requestCount}/${totalRequests}...`);

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
            metrics: ['distance', 'duration']
          },
          {
            headers: {
              Authorization: orsKey,
            }
          }
        );

        let retries = 0;
        const maxRetries = 3;
        let success = false;

        while (!success && retries <= maxRetries) {
          try {
            const result = await firstValueFrom(req$) as any;

            if (result.metadata) {
              lastMetadata = result.metadata;
            }

            for (let localI = 0; localI < result.distances.length; localI++) {
              for (let localJ = 0; localJ < result.distances[localI].length; localJ++) {
                const globalI = startI + localI;
                const globalJ = startJ + localJ;
                fullDistanceMatrix[globalI][globalJ] = result.distances[localI][localJ];
                fullDurationMatrix[globalI][globalJ] = result.durations[localI][localJ];
              }
            }

            for (let localI = 0; localI < result.sources.length; localI++) {
              const globalI = startI + localI;
              allSources[globalI] = result.sources[localI];
            }

            for (let localJ = 0; localJ < result.destinations.length; localJ++) {
              const globalJ = startJ + localJ;
              allDestinations[globalJ] = result.destinations[localJ];
            }

            success = true;
            console.log(`✅ Request ${requestCount} completed successfully`);

          } catch (error: any) {
            if (error.status === 429 && retries < maxRetries) {
              retries++;
              const waitTime = Math.pow(2, retries) * 3000;
              console.warn(`⚠️ Rate limit (429) on request ${requestCount}, waiting ${waitTime/1000}s... (attempt ${retries}/${maxRetries})`);
              await sleep(waitTime);
            } else {
              console.error(`❌ Error on request ${requestCount}:`, error);
              throw error;
            }
          }
        }

        if (requestCount < totalRequests) {
          const elapsed = Date.now() - startTime;
          const waitTime = Math.max(MIN_DELAY_MS - elapsed, 0);
          
          if (waitTime > 0) {
            console.log(`⏳ Waiting ${(waitTime/1000).toFixed(1)}s before next request...`);
            await sleep(waitTime);
          }
        }
      }
    }

    console.log('✅ Distance matrix completed!');
    return { 
      distances: fullDistanceMatrix,
      durations: fullDurationMatrix,
      sources: allSources,
      destinations: allDestinations,
      metadata: lastMetadata
    };
  }

  /**
   * Optimisation avancée avec stratégie Sweep + Time Windows
   * Gère >50 adresses et >3 camions en divisant le problème
   */
  public async optimizeAdvanced(params: {
    nbVehicules: number,
    maxTimePerVehicule: number,
    adresses: readonly Adresse[],
    parking: Adresse,
    preCalculatedMatrix?: {
      distances: number[][];
      durations: number[][];
    }
  }): Promise<OptimizationResult[]> {
    const { nbVehicules, maxTimePerVehicule, adresses, parking, preCalculatedMatrix } = params;
    
    console.log('🚀 Starting advanced optimization...');
    console.log(`📊 Input: ${adresses.length} addresses, ${nbVehicules} vehicles, ${maxTimePerVehicule}s max per vehicle`);
    
    // ÉTAPE 1: Obtenir la matrice (soit pré-calculée, soit la calculer)
    let distances: number[][];
    let durations: number[][];
    
    if (preCalculatedMatrix) {
      console.log('✅ Using pre-calculated matrix');
      distances = preCalculatedMatrix.distances;
      durations = preCalculatedMatrix.durations;
    } else {
      console.log('\n📐 Step 1: Calculating distance matrix...');
      const matrixResult = await this.getDistanceMatrix([parking, ...adresses]);
      distances = matrixResult.distances;
      durations = matrixResult.durations;
    }
    
    // ÉTAPE 2: Calculer les angles pour le sweep
    console.log('🧭 Step 2: Computing angles from parking...');
    const addressesWithAngles = adresses.map((addr, idx) => ({
      address: addr,
      originalIndex: idx + 1, // +1 car parking est à l'index 0 dans la matrice
      angle: this.computeAngle(parking, addr)
    })).sort((a, b) => a.angle - b.angle);
    
    // ÉTAPE 3: Construire les routes avec contrainte de temps (Sweep)
    console.log('🔄 Step 3: Building routes with sweep algorithm...');
    const routes = this.buildRoutesWithSweep(
      addressesWithAngles,
      durations,
      maxTimePerVehicule
    );
    
    console.log(`✅ Created ${routes.length} initial routes`);
    console.log('Route sizes:', routes.map(r => r.length));
    
    // ÉTAPE 4: Équilibrer pour avoir le bon nombre de véhicules
    console.log(`⚖️ Step 4: Balancing routes to ${nbVehicules} vehicles...`);
    const balancedRoutes = this.balanceRoutes(
      routes,
      nbVehicules,
      durations,
      maxTimePerVehicule
    );
    
    console.log(`✅ Balanced to ${balancedRoutes.length} routes`);
    console.log('Balanced route sizes:', balancedRoutes.map(r => r.length));
    
    // ÉTAPE 5: Optimiser chaque route avec l'API ORS
    console.log('\n🎯 Step 5: Optimizing each route with ORS API...');
    const optimizedRoutes: OptimizationResult[] = [];
    
    for (let i = 0; i < balancedRoutes.length; i++) {
      const route = balancedRoutes[i];
      
      if (route.length === 0) {
        console.warn(`⚠️ Route ${i + 1} is empty, skipping...`);
        continue;
      }
      
      const routeAddresses = route.map(idx => adresses[idx - 1]);
      
      console.log(`  📍 Optimizing route ${i + 1}/${balancedRoutes.length} (${routeAddresses.length} addresses)...`);
      
      try {
        if (routeAddresses.length > 50) {
          console.warn(`⚠️ Route ${i + 1} has ${routeAddresses.length} addresses (max 50). Splitting...`);
          const subRoutes = this.splitRoute(route, 50);
          
          for (const subRoute of subRoutes) {
            const subAddresses = subRoute.map(idx => adresses[idx - 1]);
            const result = await this.optimize({
              nbVehicules: 1,
              maxTimePerVehicule,
              adresses: subAddresses,
              parking
            });
            optimizedRoutes.push(result);
          }
        } else {
          const result = await this.optimize({
            nbVehicules: 1,
            maxTimePerVehicule,
            adresses: routeAddresses,
            parking
          });
          optimizedRoutes.push(result);
        }
        
        if (i < balancedRoutes.length - 1) {
          await this.sleep(1500);
        }
      } catch (error) {
        console.error(`❌ Error optimizing route ${i + 1}:`, error);
      }
    }
    
    console.log(`\n✅ Optimization completed! ${optimizedRoutes.length} routes optimized.`);
    
    const totalDistance = optimizedRoutes.reduce((sum, r) => 
      sum + (r.routes[0]?.cost || 0), 0
    );
    const totalDuration = optimizedRoutes.reduce((sum, r) => 
      sum + (r.routes[0]?.duration || 0), 0
    );
    
    console.log(`📊 Total distance: ${(totalDistance / 1000).toFixed(2)} km`);
    console.log(`⏱️ Total duration: ${(totalDuration / 3600).toFixed(2)} hours`);
    
    return optimizedRoutes;
  }

  /**
   * Calcule l'angle depuis le parking (pour le sweep algorithm)
   */
  private computeAngle(parking: Adresse, address: Adresse): number {
    const dx = address.lng - parking.lng;
    const dy = address.lat - parking.lat;
    return Math.atan2(dy, dx);
  }

  /**
   * Construit les routes initiales avec l'algorithme de balayage (sweep)
   */
  private buildRoutesWithSweep(
    addressesWithAngles: Array<{ address: Adresse; originalIndex: number; angle: number }>,
    durations: number[][],
    maxTimePerVehicule: number
  ): number[][] {
    const routes: number[][] = [];
    let currentRoute: number[] = [];
    let currentTime = 0;
    
    const SERVICE_TIME = 300; // 5 minutes
    const SETUP_TIME = 30;    // 30 secondes
    
    for (const item of addressesWithAngles) {
      const addrIdx = item.originalIndex;
      const lastIdx = currentRoute.length === 0 ? 0 : currentRoute[currentRoute.length - 1];
      
      const travelTime = durations[lastIdx][addrIdx];
      const totalTime = travelTime + SETUP_TIME + SERVICE_TIME;
      const returnTime = durations[addrIdx][0];
      
      if (currentTime + totalTime + returnTime <= maxTimePerVehicule) {
        currentRoute.push(addrIdx);
        currentTime += totalTime;
      } else {
        if (currentRoute.length > 0) {
          routes.push([...currentRoute]);
        }
        currentRoute = [addrIdx];
        currentTime = durations[0][addrIdx] + SETUP_TIME + SERVICE_TIME;
      }
    }
    
    if (currentRoute.length > 0) {
      routes.push(currentRoute);
    }
    
    return routes;
  }

  /**
   * Équilibre les routes pour correspondre au nombre de véhicules demandé
   */
  private balanceRoutes(
    routes: number[][],
    targetNbVehicules: number,
    durations: number[][],
    maxTimePerVehicule: number
  ): number[][] {
    if (routes.length === targetNbVehicules) {
      return routes;
    }
    
    if (routes.length > targetNbVehicules) {
      console.log(`⚠️ Too many routes (${routes.length}), merging smallest ones...`);
      
      const workingRoutes = [...routes];
      
      while (workingRoutes.length > targetNbVehicules) {
        workingRoutes.sort((a, b) => a.length - b.length);
        
        const smallest = workingRoutes.shift()!;
        const secondSmallest = workingRoutes.shift()!;
        
        const merged = [...smallest, ...secondSmallest];
        const mergedTime = this.calculateRouteTime(merged, durations);
        
        if (mergedTime <= maxTimePerVehicule && merged.length <= 50) {
          workingRoutes.push(merged);
        } else {
          workingRoutes.push(smallest);
          workingRoutes.push(secondSmallest);
          break;
        }
      }
      
      return workingRoutes;
    }
    
    if (routes.length < targetNbVehicules) {
      console.log(`⚠️ Not enough routes (${routes.length}), splitting largest ones...`);
      
      const workingRoutes = [...routes];
      
      while (workingRoutes.length < targetNbVehicules) {
        workingRoutes.sort((a, b) => b.length - a.length);
        
        const largest = workingRoutes.shift()!;
        
        if (largest.length <= 1) {
          workingRoutes.push(largest);
          break;
        }
        
        const mid = Math.floor(largest.length / 2);
        
        workingRoutes.push(largest.slice(0, mid));
        workingRoutes.push(largest.slice(mid));
      }
      
      return workingRoutes;
    }
    
    return routes;
  }

  /**
   * Calcule le temps total d'une route
   */
  private calculateRouteTime(route: number[], durations: number[][]): number {
    if (route.length === 0) return 0;
    
    const SERVICE_TIME = 300;
    const SETUP_TIME = 30;
    
    let totalTime = 0;
    
    totalTime += durations[0][route[0]] + SETUP_TIME + SERVICE_TIME;
    
    for (let i = 1; i < route.length; i++) {
      totalTime += durations[route[i - 1]][route[i]] + SETUP_TIME + SERVICE_TIME;
    }
    
    totalTime += durations[route[route.length - 1]][0];
    
    return totalTime;
  }

  /**
   * Divise une route trop longue en plusieurs sous-routes
   */
  private splitRoute(route: number[], maxSize: number): number[][] {
    const subRoutes: number[][] = [];
    
    for (let i = 0; i < route.length; i += maxSize) {
      subRoutes.push(route.slice(i, i + maxSize));
    }
    
    return subRoutes;
  }

  /**
   * Fonction utilitaire pour attendre
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Convert GeoJSON [lng, lat] to Leaflet [lat, lng]
 */
export function geoJsonLngLatToLatLng(lngLat: number[]): LatLngTuple {
  return [lngLat[1], lngLat[0]];
}