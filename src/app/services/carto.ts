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

  // Fonction utilitaire pour attendre
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Initialiser les matrices complètes
  const fullDistanceMatrix: number[][] = Array(totalAddresses)
    .fill(null)
    .map(() => Array(totalAddresses).fill(0));
  
  const fullDurationMatrix: number[][] = Array(totalAddresses)
    .fill(null)
    .map(() => Array(totalAddresses).fill(0));

  // Initialiser les sources et destinations
  const allSources: Array<{ location: [number, number]; snapped_distance: number }> = 
    Array(totalAddresses).fill(null).map(() => ({ location: [0, 0], snapped_distance: 0 }));
  const allDestinations: Array<{ location: [number, number]; snapped_distance: number }> = 
    Array(totalAddresses).fill(null).map(() => ({ location: [0, 0], snapped_distance: 0 }));

  // Calculer le nombre de chunks nécessaires
  const numChunks = Math.ceil(totalAddresses / maxLocationsPerRequest);
  
  let requestCount = 0;
  const totalRequests = numChunks * numChunks;
  let lastMetadata: any = null;

  // Traiter chaque combinaison de chunks
  for (let i = 0; i < numChunks; i++) {
    for (let j = 0; j < numChunks; j++) {
      requestCount++;
      console.log(`Processing request ${requestCount}/${totalRequests}...`);

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

      try {
        const result = await firstValueFrom(req$) as any;

        if (result.metadata) {
          lastMetadata = result.metadata;
        }

        // Remplir les matrices
        for (let localI = 0; localI < result.distances.length; localI++) {
          for (let localJ = 0; localJ < result.distances[localI].length; localJ++) {
            const globalI = startI + localI;
            const globalJ = startJ + localJ;
            fullDistanceMatrix[globalI][globalJ] = result.distances[localI][localJ];
            fullDurationMatrix[globalI][globalJ] = result.durations[localI][localJ];
          }
        }

        // Mettre à jour les sources
        for (let localI = 0; localI < result.sources.length; localI++) {
          const globalI = startI + localI;
          allSources[globalI] = result.sources[localI];
        }

        // Mettre à jour les destinations
        for (let localJ = 0; localJ < result.destinations.length; localJ++) {
          const globalJ = startJ + localJ;
          allDestinations[globalJ] = result.destinations[localJ];
        }

        if (requestCount < totalRequests) {
          await sleep(3000);
        }
      } catch (error) {
        console.error(`Error on request ${requestCount}:`, error);
        throw error;
      }
    }
  }

  console.log('Distance matrix completed!');
  return { 
    distances: fullDistanceMatrix,
    durations: fullDurationMatrix,
    sources: allSources,
    destinations: allDestinations,
    metadata: lastMetadata
  };
}
}

/**
 * Convert GeoJSON [lng, lat] to Leaflet [lat, lng]
 */
export function geoJsonLngLatToLatLng(lngLat: number[]): LatLngTuple {
  return [lngLat[1], lngLat[0]];
}