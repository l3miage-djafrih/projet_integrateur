import { Component, computed, effect, inject, Signal, signal, WritableSignal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { latLng, LatLngBoundsLiteral, LatLngTuple, Layer, MapOptions, Marker, polyline, Rectangle, rectangle, tileLayer } from 'leaflet';
import { Carto } from './services/carto';
import { getMarker } from './utils/marker';
import { FormsModule } from '@angular/forms';
import { Adresse } from './data/adresse';
import { OptimizationResult } from './services/OptimizationResult';
import { Sweep } from './services/sweepAlgorithme';
import { adresse50 } from './data/dataSet50Adresses/adresse_47_complete';
import { adresse400 } from './data/dataSet400Adresses/adresses_377._complete';
import { adresse100 } from './data/dataSet100Adresses/adresse_96_complete';
import { Injector, runInInjectionContext } from '@angular/core';


const lastAdressesKey = "adresses";
const lastOptimizationResponseKey = "lastOptimizationResponse";
const lastRoutesKey = "lastRoutes";

@Component({
  selector: 'app-root',
  imports: [
    // RouterOutlet,
    FormsModule,
    LeafletModule
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  // Services
  private readonly _srvCarto = inject(Carto);
  private readonly _sweepService=inject(Sweep)
  private readonly injector = inject(Injector);

 

  

  // Local state
  private readonly bounds = signal<LatLngBoundsLiteral>([[45.1, 5.6], [45.3, 5.9]]); // Rectangle autour de Grenoble
  // Options de la carte Leaflet, à conserver en tant que constante car c'est ainsi que la bibliothèque gère cette entrée... 
  // (une erreur de leur part)
  protected readonly options: MapOptions = {
    zoom: 11,
    center: latLng(45.188529, 5.724524), // Coordonnée de Grenoble
  };

  public readonly _adresses = signal<readonly Adresse[]>(
    adresse400) 
  
  private readonly _optimizationResult: WritableSignal<undefined | OptimizationResult>;
  private readonly _routes = signal<ReadonlyArray<ReadonlyArray<LatLngTuple>>>(
    localStorage.getItem(lastRoutesKey) ? JSON.parse(localStorage.getItem(lastRoutesKey)!) : []
  );

  // Les différentes couches de la carte Leaflet,
  // sous forme de signal car elles peuvent évoluer au cours du temps
  // On doit malheureusement transmettre des tableaux mutables...
  // Encore une erreur des concepteurs de cette bibliothèque...
  protected readonly layers: Signal<Layer[]>;
  private readonly colors = ['red',
  'green',
  'blue',
  'orange',
  'cyan',
  'purple',
  'magenta',
  'yellow',
  'lime',
  'teal',
  'pink',
  'brown',
  'black',
  'gray',
  'navy',
  'olive',
  'maroon',
  'gold',
  'coral',
  'darkred',
  'darkblue',
  'darkgreen',
  'darkorange',
  'darkviolet',
  'deepskyblue'];
  constructor() {
    const back = tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '...' });
    const bboxRectangle: Signal<Rectangle> = computed<Rectangle>(
      () => rectangle(this.bounds(), { color: 'blue', weight: 1 })
    );
    this.layers = computed<Layer[]>(
      () => [
        back,
        bboxRectangle(),
        // Convention : last adresse is the one of the parking
        ...this._adresses().map((a, i) => getMarker(a, i === this._adresses().length - 1 ? 'black' : 'blue')),
        ...this._routes().map((r, i) => polyline([...r], { color: this.colors[i % this.colors.length] }))
      ]
    );

    // Get optimization result from localStorage if any
    const lastOptStr = localStorage.getItem(lastOptimizationResponseKey);
    this._optimizationResult = signal<undefined | OptimizationResult>(
      lastOptStr && lastOptStr !== "undefined" ? JSON.parse(lastOptStr) : undefined
    );

    // Save addresses to localStorage on change
    effect(() => localStorage.setItem(lastAdressesKey, JSON.stringify(this._adresses())));
    
    // Save optimization result to localStorage on change
    effect(() => {
      const opt = this._optimizationResult();
      console.log("Optimization :", opt)
      localStorage.setItem(lastOptimizationResponseKey, JSON.stringify(opt))
    });

    // Save routes on change
    effect(() => localStorage.setItem(lastRoutesKey, JSON.stringify(this._routes())));
  }

  /**
   * Generate random points within the bounding box and fetch their addresses.
   */
 /**
 * Filtre les adresses inaccessibles (trop loin des routes).
 * Met à jour _adresses avec seulement les adresses accessibles.
 * @returns Le nombre d'adresses supprimées
 */
private async filterInaccessibleAddresses(): Promise<number> {
  const allAddresses = this._adresses();
  
  if (allAddresses.length === 0) {
    console.warn('⚠️ No addresses to filter');
    return 0;
  }

  console.log(`🔍 Checking accessibility for ${allAddresses.length} addresses...`);
  
  try {
    const matrixResult = await this._srvCarto.getDistanceMatrix(allAddresses);
    const MAX_SNAPPED_DISTANCE = 150; // 150m max
    
    const accessibleAddresses: Adresse[] = [];
    let removedCount = 0;
    
    matrixResult.sources.forEach((source, index) => {
      if (source.snapped_distance <= MAX_SNAPPED_DISTANCE) {
        accessibleAddresses.push(allAddresses[index]);
      } else {
        removedCount++;
        console.warn(
          `⏭️ Removed: "${allAddresses[index].name}" ` +
          `(${source.snapped_distance.toFixed(0)}m from road)`
        );
      }
    });
    
    // Mettre à jour avec seulement les adresses accessibles
    this._adresses.set(accessibleAddresses);
    
    console.log(`✅ ${accessibleAddresses.length}/${allAddresses.length} addresses are accessible`);
    
    return removedCount;
    
  } catch (err) {
    console.error('❌ Error checking accessibility:', err);
    throw err;
  }
}

/**
 * Génère un nombre donné d'adresses aléatoires dans la zone,
 * puis filtre celles qui sont inaccessibles par la route.
 */
protected async generateAdresses(nb: number): Promise<void> {
  const bounds = this.bounds();
  const southWest = bounds[0];
  const northEast = bounds[1];

  // Réinitialisation
  this._adresses.set([]);
  this._routes.set([]);
  this._optimizationResult.set(undefined);
  
  let remaining = nb;

  console.log(`🎯 Target: ${nb} addresses\n`);

  // ÉTAPE 1: Générer les adresses
  while (remaining > 0) {
    const points = Array.from({ length: remaining }, () => ({
      lat: Math.random() * (northEast[0] - southWest[0]) + southWest[0],
      lng: Math.random() * (northEast[1] - southWest[1]) + southWest[1],
    }));
    
    await this._srvCarto.getAdressesFromCoordinates(points).then((adresses) => {
      console.log(`📬 Fetched ${adresses.length} addresses`);
      this._adresses.update(L => [...L, ...adresses]);
      remaining = nb - this._adresses().length;
      console.log(`📊 Progress: ${this._adresses().length}/${nb} (remaining: ${remaining})`);
    });
  }
  
  const generatedCount = this._adresses().length;
  console.log(`✅ All ${generatedCount} addresses generated.\n`);

  // ÉTAPE 2: Filtrer les adresses inaccessibles
  const removedCount = await this.filterInaccessibleAddresses();
  
  // ÉTAPE 3: Afficher les résultats
  console.log(`\n📊 Final Results:`);
  console.log(`  🎯 Requested: ${nb}`);
  console.log(`  📍 Generated: ${generatedCount}`);
  console.log(`  ✅ Accessible: ${this._adresses().length}`);
  console.log(`  ❌ Removed: ${removedCount}`);
  console.log(`  📈 Keep rate: ${(this._adresses().length/nb*100).toFixed(1)}%`);
  
  if (this._adresses().length === 0) {
    console.error('\n❌ No accessible addresses found!');
    return;
  }

  // ÉTAPE 4: Téléchargement
  this.downloadAdressesJson(this._adresses().length);
  await this.downloadMatrix(this._adresses().length);
  
}

  /**
   * Optimization of the routes with the given number of vehicles.
   * The steps are provided by the adresses signal attribute.
   */
 
  protected optimizeRoutes(
    nbVehicules: number,
    maxTimePerVehicule: number,
    adresses?:readonly Adresse[]
  ): void {
   
    if (!adresses || adresses.length === 0) {
      console.warn('No addresses to optimize.');
      return;
    }
    this._srvCarto.optimize({
      nbVehicules,
      maxTimePerVehicule,
      adresses: adresses.slice(0, -1),
      parking: adresses.at(-1)!
    }).catch(
      err => {
        console.error('Optimization error:', err);
        this._optimizationResult.set(undefined);
        return undefined;
      }
    ).then(
      opt => {
        this._optimizationResult.set(opt);
        if (opt === undefined) return undefined;
        return Promise.all(
          opt.routes.map(
            route => this._srvCarto.getDirections( route.steps.map(s => s.location) )
          )
        )
      }
    ).then(
      routes => this._routes.set(routes ?? [])
    );
  }



















  //fonction downloadAdressesJson() pour enregistrer les adresses dans un fichiers puis les telecharger
  private downloadAdressesJson(nb: number): void {
  const data = JSON.stringify(this._adresses(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });

  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `adresses_${nb}.json`;
  a.click();

  window.URL.revokeObjectURL(url);
}




// téléchargement de la matirce comme fichier JSON

private async downloadMatrix(nb: number): Promise<void> {
  try {
    const matrixResult = await this._srvCarto.getDistanceMatrix(this._adresses());
    
    // Analyser la qualité du snapping
    const avgSnappedDistance = matrixResult.sources.reduce((sum: number, s: any) => sum + s.snapped_distance, 0) / matrixResult.sources.length;
    console.log(`Average snapped distance: ${avgSnappedDistance.toFixed(2)}m`);
    
    if (avgSnappedDistance > 100) {
      console.warn('⚠️ High snapped distances detected! Some addresses may be far from roads.');
    }

    const data = JSON.stringify({
      distances: matrixResult.distances,
      durations: matrixResult.durations,
      sources: matrixResult.sources,
      destinations: matrixResult.destinations,
      metadata: matrixResult.metadata,
      statistics: {
        totalAddresses: nb,
        avgSnappedDistance: avgSnappedDistance,
        maxSnappedDistance: Math.max(...matrixResult.sources.map((s: any) => s.snapped_distance)),
        timestamp: new Date().toISOString()
      }
    }, null, 2);

    const blob = new Blob([data], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `matrix_${nb}_complete.json`;
    a.click();

    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error("Matrix error:", err);
  }
}


/**
 * je vais définir ma liste d'angles que je vais trier en ordre croissant ensuite je vais générer des chunks
 */















protected async optimizeRoutesAndAppend(
  nbVehicules: number,
  maxTimePerVehicule: number,
  adresses: readonly Adresse[]
): Promise<void> {

  const previousRoutes = this._routes();

  // appel SANS modifier optimizeRoutes
  this.optimizeRoutes(nbVehicules, maxTimePerVehicule, adresses);

  // attendre la vraie mise à jour de _routes
  const newRoutes = await runInInjectionContext(
    this.injector,
    () =>
      new Promise<ReadonlyArray<ReadonlyArray<LatLngTuple>>>(resolve => {
        const ref = effect(() => {
          const current = this._routes();
          if (current !== previousRoutes) {
            ref.destroy();
            resolve(current);
          }
        });
      })
  );

  // concaténation des routes 
  this._routes.set([
    ...previousRoutes,
    ...newRoutes
  ]);


}


public async optimizationSweeper(vehicules: number, time: number): Promise<void> {
  // nombre de véhicules insérés par l'utilisatuer 
  let vehiculesRestant = vehicules;
  this._routes.set([]);

  const parking = this._adresses().at(-1)!;
  const angles = this._sweepService.constructionDesAngles(this._adresses(), parking);
  const chunks = this._sweepService.constructionChunkes(angles);

  console.log(`${chunks.length} chunks générés.`);

  for (const chunk of chunks) {
    let routesAvant = JSON.parse(JSON.stringify(this._routes()));
    let chunkSolved = false;

    if (vehiculesRestant === 0) {
      console.warn(" Plus de véhicules disponibles !");
      break;
    }

    const chunkWithParking = [...chunk, parking];

  
    for (let vehiculeCurrent = 1; vehiculeCurrent <= 3; vehiculeCurrent++) {
      if (vehiculeCurrent > vehiculesRestant) break;

      console.log(`je vais essayer  ${vehiculeCurrent} véhicule(s) pour ce chunk`);

      await this.optimizeRoutesAndAppend(vehiculeCurrent, time, chunkWithParking);

      const unassignedLength = this._optimizationResult()?.unassigned?.length ?? 0;
      console.log(`Adresses non livrées : ${unassignedLength}`);

      if (unassignedLength === 0) {
        vehiculesRestant -= vehiculeCurrent;
        chunkSolved = true;
        break; // on passe au chunk suivant
      } else {
        console.warn(` Impossible avec ${vehiculeCurrent} véhicule(s), `);
        this._routes.set(routesAvant);
        this._optimizationResult.set(undefined);
      }
    }

    if (!chunkSolved) {
      console.warn("ce chunk n'as pas pu être résolu ,je vais passer au suivant ");
     
      this._routes.set(routesAvant);
    }

    // Pause 
    await new Promise(r => setTimeout(r, 1000));
  }

  const Vehiculesutilisés = vehicules - vehiculesRestant;
  console.log(` Optimisation terminée. Véhicules utilisés : ${Vehiculesutilisés}`);
  if(Vehiculesutilisés<vehicules){
    console.log("le nombre de véhicules nécessaires est seulement "+Vehiculesutilisés);
  }
}

  

  


   

   




 

}
