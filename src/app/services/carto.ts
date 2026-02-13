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