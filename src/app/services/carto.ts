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

/**
 * Encapsulates access to gouv.fr cartographic services (geocoding, etc.).
 * See https://adresse.data.gouv.fr/api-doc/adresse
 *     https://geoservices.ign.fr/documentation/services/services-geoplateforme/geocodage
 *     https://data.geopf.fr/geocodage/openapi
 * Indication : Paramétrer le script de telle sorte que la fréquence d'appel à l'API de géocodage ne dépasse pas 50 requêtes par seconde, en instaurant par exemple un plafond à 40 ou 45 requêtes par seconde.
 */
const cartoURL = 'https://api-adresse.data.gouv.fr';

@Injectable({
  providedIn: 'root',
})
export class Carto {
  private readonly _httpClient = inject(HttpClient);

  /**
   * Gouv.api Reverse geocoding: from coordinates to addresses.
   * @param L List of coordinates (latitude, longitude)
   * @returns Promise resolving to the list of addresses corresponding to the given coordinates.
   * Only the coordinates that could be reverse geocoded will be present in the result.
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
    
    formData.append("data", csvBlob); // Suffixer avec nom de fichier ???

    // Observable de la requête HTTP POST
    const req$ = this._httpClient.post(url.toString(), formData, { responseType: 'text' });
    
    // Déclanchement de l'observable par la souscription et conversion en Promesse (fonction firstValueFrom)
    return firstValueFrom(req$).then(
      extractAdressesFromApiGouvResponseString
    )
  }

  /**
   * OpenRouteService Optimization API call.
   * @param nbVehicules Number of vehicles to use for the optimization. 
   * @param adresses 
   * @returns 
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
    
    // depotLngLat
    const Ljobs = adresses.map(
      (a, i) => ({
        id: i,
        location: [a.lng, a.lat],
        setup: 30,
        service: 300,
      })
    );

    // Request
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

    // Send request using firstValueFrom
    return firstValueFrom(req$).then(
      parseOptimizationResultP
    );
  }

  /**
   * OpenRouteService direction API call.
   */
  public getDirections(lngLatCoordinates: readonly RouteStepBase['location'][]): Promise<ReadonlyArray<LatLngTuple>> {
    // https://api.openrouteservice.org/v2/directions/driving-car/geojson
    // coordinates : LngLat array
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
}

/**
 * Convert GeoJSON [lng, lat] to Leaflet [lat, lng]
 * @param lngLat GeoJSON coordinate, contains at least [longitude, latitude]s
 * @returns a leaflet LatLngTuple
 */
export function geoJsonLngLatToLatLng(lngLat: number[]): LatLngTuple {
  return [lngLat[1], lngLat[0]];
}
