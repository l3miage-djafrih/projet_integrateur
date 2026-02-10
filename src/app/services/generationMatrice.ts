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
}
