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
import { optimiseEquitable } from './optimisation-algo.service';

const cartoURL = 'https://api-adresse.data.gouv.fr';

@Injectable({
  providedIn: 'root',
})
export class Carto {
  private readonly _httpClient = inject(HttpClient);

  /**
   * Attente pour respecter les limites de taux
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Reverse geocoding: des coordonnees vers des adresses
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
   * Appel a l'API Optimization d'OpenRouteService avec pause
   */
  public async optimize(params: Readonly<{
    nbVehicules: number,
    maxTimePerVehicule: number,
    adresses: readonly Adresse[],
    parking: Adresse
  }>): Promise<OptimizationResult> {
    
    await this.sleep(3000);
    
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
   * Appel a l'API Directions d'OpenRouteService avec pause
   */
  public async getDirections(lngLatCoordinates: readonly RouteStepBase['location'][]): Promise<ReadonlyArray<LatLngTuple>> {
    
    await this.sleep(3000);
    
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
   * Point d'entree - Delegation a l'algorithme de repartition equitable
   */
  public async optimiseEquitable(
    adresses: readonly Adresse[],
    nbVehicules: number,
    maxTimePerVehicule: number
  ): Promise<{
    results: OptimizationResult[];
    stats: {
      totalPoints: number;
      vehiculesDemandes: number;
      vehiculesMinimum: number;
      vehiculesUtilises: number;
      totalPaquets: number;
      totalDuree: number;
      totalCout: number;
      alerte?: string;
    }
  }> {
    return optimiseEquitable(
      adresses,
      nbVehicules,
      maxTimePerVehicule,
      this.optimize.bind(this)
    );
  }

  /**
   * Point d'entree unique - Optimise et exporte automatiquement
   */
  public async optimizeAndExport(
    adresses: readonly Adresse[],
    nbVehicules: number,
    maxTimePerVehicule: number
  ): Promise<OptimizationResult[]> {
    const result = await this.optimiseEquitable(adresses, nbVehicules, maxTimePerVehicule);
    
    const jobs = adresses.slice(0, -1);
    const parking = adresses[adresses.length - 1];
    this.exportSimpleJSON(jobs, parking, result.results, result.stats);
    
    return result.results;
  }

  /**
   * Export JSON complet des tournees
   */
  private exportSimpleJSON(
    jobs: Adresse[],
    parking: Adresse,
    results: OptimizationResult[],
    stats: any
  ): void {
    
    console.log(`\nExport JSON - ${jobs.length} points, ${results.length} paquet(s)`);
    
    const jobsMap = new Map<number, Adresse>();
    jobs.forEach((job, index) => jobsMap.set(index, job));
    
    const exportData: any = {
      date: new Date().toLocaleString('fr-FR'),
      synthese: {
        points: jobs.length,
        vehicules: {
          demandes: stats.vehiculesDemandes || 0,
          minimum: stats.vehiculesMinimum || 0,
          utilises: stats.vehiculesUtilises || results.reduce((s, r) => s + r.routes.length, 0)
        },
        performance: {
          cout: stats.totalCout || results.reduce((s, r) => s + r.summary.cost, 0),
          duree_min: Math.round((stats.totalDuree || results.reduce((s, r) => s + r.summary.duration, 0)) / 60)
        }
      },
      parking: {
        nom: parking.name,
        adresse: `${parking.name}, ${parking.postCode} ${parking.city}`,
        ville: parking.city,
        codePostal: parking.postCode,
        coordonnees: {
          lat: parking.lat,
          lng: parking.lng
        }
      },
      tournees: []
    };

    let totalArretsCompteur = 0;
    
    for (let p = 0; p < results.length; p++) {
      const result = results[p];
      
      for (let r = 0; r < result.routes.length; r++) {
        const route = result.routes[r];
        const etapesLivraison = route.steps.slice(1, -1);
        
        const livraisons = etapesLivraison.map((_, order) => {
          const jobIndex = (totalArretsCompteur + order) % jobs.length;
          const job = jobsMap.get(jobIndex);
          
          return {
            ordre: order + 1,
            jobId: jobIndex,
            nom: job?.name || 'Livraison',
            adresse: job ? `${job.name}, ${job.postCode} ${job.city}` : 'Adresse inconnue',
            ville: job?.city || 'Inconnu',
            codePostal: job?.postCode || '',
            coordonnees: job ? {
              lat: job.lat,
              lng: job.lng
            } : null
          };
        });

        totalArretsCompteur += livraisons.length;

        exportData.tournees.push({
          id: `${p + 1}.${r + 1}`,
          paquet: p + 1,
          vehicule: route.vehicle,
          statistiques: {
            arrets: livraisons.length,
            duree_secondes: route.duration,
            duree_min: Math.round(route.duration / 60),
            cout: route.cost
          },
          ordre_livraison: livraisons.map(l => ({
            ordre: l.ordre,
            adresse: l.adresse,
            ville: l.ville,
            codePostal: l.codePostal
          })),
          adresses: livraisons.map(l => l.adresse),
          details: livraisons
        });
      }
    }

    exportData.statistiques_avancees = {
      points_par_vehicule: (jobs.length / Math.max(1, exportData.synthese.vehicules.utilises)).toFixed(2),
      cout_par_point: (exportData.synthese.performance.cout / jobs.length).toFixed(2),
      temps_par_point: Math.round(exportData.synthese.performance.duree_min * 60 / jobs.length) + 's',
      total_arrets: totalArretsCompteur,
      points_non_livres: jobs.length - totalArretsCompteur,
      taux_couverture: `${((totalArretsCompteur / jobs.length) * 100).toFixed(1)}%`
    };

    console.log(`Points totaux: ${jobs.length}`);
    console.log(`Arrets trouves: ${totalArretsCompteur}/${jobs.length}`);
    
    if (totalArretsCompteur < jobs.length) {
      console.warn(`Points non livres: ${jobs.length - totalArretsCompteur}/${jobs.length}`);
    } else {
      console.log(`Tous les points sont livres`);
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tournees_${jobs.length}pts_${new Date().getTime()}.json`;
    a.click();
    window.URL.revokeObjectURL(url);
    
    console.log(`JSON exporte: ${exportData.tournees.length} tournees, ${totalArretsCompteur}/${jobs.length} arrets`);
  }

  /**
   * Calcule la matrice de distances routieres entre adresses
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

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

    for (let i = 0; i < numChunks; i++) {
      for (let j = 0; j < numChunks; j++) {
        requestCount++;
        console.log(`Traitement requete ${requestCount}/${totalRequests}...`);

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

          if (requestCount < totalRequests) {
            await sleep(3000);
          }
        } catch (error) {
          console.error(`Erreur requete ${requestCount}:`, error);
          throw error;
        }
      }
    }

    console.log('Matrice de distances complete');
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
 * Convertit [lng, lat] (GeoJSON) vers [lat, lng] (Leaflet)
 */
export function geoJsonLngLatToLatLng(lngLat: number[]): LatLngTuple {
  return [lngLat[1], lngLat[0]];
}