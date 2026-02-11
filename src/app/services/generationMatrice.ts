import { Injectable, inject } from "@angular/core";
import { Matrice, parseMatrice } from "../data/Matrice";
import { Adresse } from "../data/adresse";
import { orsKey } from "./orsKey";
import { HttpClient } from "@angular/common/http";
import { firstValueFrom } from "rxjs";

@Injectable({
  providedIn: "root",
})
export class adresseToMatrice {
  private readonly http = inject(HttpClient);
  private readonly MAX_LOCATIONS_PER_REQUEST = 40; 

  async getDistanceMatrix(adresses: readonly Adresse[]): Promise<Matrice> {
    if (adresses.length <= this.MAX_LOCATIONS_PER_REQUEST) {
      return this.requestSingleMatrix(adresses);
    }

    return this.getDistanceMatrixChunked(adresses);
  }

  private async requestSingleMatrix(adresses: readonly Adresse[]): Promise<Matrice> {
    const locations = adresses.map(a => [a.lng, a.lat]);

    const req$ = this.http.post(
      "https://api.openrouteservice.org/v2/matrix/driving-car",
      {
        locations,
        metrics: ["distance"],
      },
      {
        headers: {
          Authorization: orsKey,
        },
      }
    );

    const result = await firstValueFrom(req$);
    return parseMatrice(result);
  }

 

  private async getDistanceMatrixChunked(adresses: readonly Adresse[]): Promise<Matrice> {
    const total = adresses.length;
    const chunkSize = this.MAX_LOCATIONS_PER_REQUEST;
    const numChunks = Math.ceil(total / chunkSize);

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Initialize full matrix
    const fullMatrix: Matrice = {
      distances: Array.from({ length: total }, () => Array(total).fill(0)),
      destinations: adresses.map(a => ({
        location: [a.lng, a.lat],
        snapped_distance: 0,
      })),
    };

    let requestCount = 0;
    const totalRequests = numChunks * numChunks;

    for (let i = 0; i < numChunks; i++) {
      for (let j = 0; j < numChunks; j++) {
        requestCount++;

        const startI = i * chunkSize;
        const endI = Math.min(startI + chunkSize, total);
        const startJ = j * chunkSize;
        const endJ = Math.min(startJ + chunkSize, total);

        const sourceAddresses = adresses.slice(startI, endI);
        const destAddresses = adresses.slice(startJ, endJ);

      
        if (sourceAddresses.length * destAddresses.length > 3500) {
          throw new Error(
            `ORS limit exceeded: ${sourceAddresses.length} x ${destAddresses.length}`
          );
        }

        const locations = [
          ...sourceAddresses.map(a => [a.lng, a.lat]),
          ...destAddresses.map(a => [a.lng, a.lat]),
        ];

        const sources = sourceAddresses.map((_, idx) => idx);
        const destinations = destAddresses.map((_, idx) => idx + sourceAddresses.length);

        console.log(
          ` Chunk ${requestCount}/${totalRequests} (${startI}-${endI} → ${startJ}-${endJ})`
        );

        const req$ = this.http.post(
          "https://api.openrouteservice.org/v2/matrix/driving-car",
          {
            locations,
            sources,
            destinations,
            metrics: ["distance"],
          },
          {
            headers: {
              Authorization: orsKey,
            },
          }
        );

        try {
          const rawResult = await firstValueFrom(req$);
          const result = parseMatrice(rawResult);

          // Fill distances
          for (let si = 0; si < result.distances.length; si++) {
            for (let dj = 0; dj < result.distances[si].length; dj++) {
              fullMatrix.distances[startI + si][startJ + dj] = result.distances[si][dj];
            }
          }

          // Fill destinations
          for (let dj = 0; dj < result.destinations.length; dj++) {
            fullMatrix.destinations[startJ + dj] = result.destinations[dj];
          }

          if (requestCount < totalRequests) {
            await sleep(2000); 
          }
        } catch (error) {
          console.error(` Error on chunk ${requestCount}/${totalRequests}`, error);
          throw error;
        }
      }
    }

    console.log(" Distance matrix completed");
    return fullMatrix;
  }
}
