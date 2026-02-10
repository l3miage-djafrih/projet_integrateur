import { Injectable, signal, computed, inject } from "@angular/core";
import { Matrice, parseMatrice } from "../data/Matrice";
import { Adresse } from "../data/adresse";
import { orsKey } from "./orsKey";
import { HttpClient } from "@angular/common/http";
import { firstValueFrom } from "rxjs";

@Injectable({
  providedIn: 'root',
})
export class adressToMatrice {

  private readonly _httpClient = inject(HttpClient);


  /**
   * 
   * @param adresses 
   * @returns une matrice de 50 
   */
  public generateMatriceFrom50Adresses(adresses: readonly Adresse[]): Promise<Matrice> {
    const locations = adresses.map(a => [a.lng, a.lat]);
    const body = {
      locations,
      metrics: ["distance"]
    };


    // appel api de création de matrice 
    const req$ = this._httpClient.post(
      'https://api.openrouteservice.org/v2/matrix/driving-car',

      body,


      {
        headers: {
          Accept: 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
          Authorization: orsKey,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );

    return firstValueFrom(req$).then(parseMatrice);
  }




  public generateMatriceFromAdresses(adresses: readonly Adresse[]): Promise<Matrice> {
    // extraction des [longtitude,latitude] à partir des adresses fournies pour les fournir comme paramétres à l'api 


    const locations = adresses.map(a => [a.lng, a.lat]);
    const body = {
      locations,
      metrics: ["distance"]
    };
    // appel api de création de matrice 
    const req$ = this._httpClient.post(
      'https://api.openrouteservice.org/v2/matrix/driving-car',

      body,


      {
        headers: {
          Accept: 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
          Authorization: orsKey,
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );

    return firstValueFrom(req$).then(parseMatrice);
  }



  
    //--------------------------------------------------------------------------------------------------------------------------------------------//


    /**
     * la fonction getDIstanceMatrixChnunked retourne la matrice des distances dans le cas ou le nombre d'adresses est >50
     * @param adresses 
     * @returns promesse de type Matrice qui contient la matrice de distances 
     */
  public async getDistanceMatrixChunked(adresses: readonly Adresse[]): Promise<Matrice> {
    const maxLocationsPerRequest = 50;
    const totalAddresses = adresses.length;
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


    // génération d'une matrice vide 
    const fullMatrix: Matrice = {
      distances: Array.from(
        { length: totalAddresses },
        () => Array(totalAddresses).fill(0)
      ),
      destinations: adresses.map(a => ({
        location: [a.lng, a.lat],
        snapped_distance: 0
      }))
    }

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
            sources,
            destinations,

            metrics: ['distance']
          },
          {
            headers: {
              Authorization: orsKey,
            }
          }
        );
        try {
          const result = await firstValueFrom(req$).then(
            parseMatrice
          )


          // remplissage de fullMatrix avec les valeurs de distances
          for (let si = 0; si < result.distances.length; si++) {
            for (let dj = 0; dj < result.distances[si].length; dj++) {
              fullMatrix.distances[startI + si][startJ + dj] =
                result.distances[si][dj];

            }
          }

          // remplissage de fullMatrix avec les valeurs de  destinations
          if (result.destinations) {
            for (let dj = 0; dj < result.destinations.length; dj++) {
              fullMatrix.destinations[startJ + dj] = {
                location: result.destinations[dj].location,
                snapped_distance: result.destinations[dj].snapped_distance
              };
            }
          }




          if (requestCount < totalRequests) {
            await sleep(1500);
          }

        } catch (error) {
          console.error(` Error on chunked request ${requestCount}:`, error);
          throw error;
        }
      }
    }

    console.log(" Chunked distance matrix complet!");
    return fullMatrix;
  }
}
