import { Component, computed, effect, inject, Signal, signal, WritableSignal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { latLng, LatLngBoundsLiteral, LatLngTuple, Layer, MapOptions, Marker, polyline, Rectangle, rectangle, tileLayer } from 'leaflet';
import { Carto } from './services/carto';
import { getMarker } from './utils/marker';
import { FormsModule } from '@angular/forms';
import { Adresse } from './data/adresse';
import { OptimizationResult } from './services/OptimizationResult';
import { Injector,runInInjectionContext } from '@angular/core';

// 🔥 IMPORT DES DONNÉES PRÉ-CALCULÉES
import { matrix400  } from './data/dataSet400Adresses/matrix_377_complete';
import { adresse400 } from './data/dataSet400Adresses/adresses_377._complete';
import { Sweep } from './services/optimisation-sweep.service';

const lastAdressesKey = "adresses";
const lastOptimizationResponseKey = "lastOptimizationResponse";
const lastRoutesKey = "lastRoutes";


@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
    LeafletModule
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  // Services
  private readonly _srvCarto = inject(Carto);
  private readonly _sweepService=inject(Sweep);
  private readonly injector=inject(Injector)

  // 🔥 DONNÉES PRÉ-CALCULÉES - EXACTEMENT COMME LA PHOTO
  matrice100 = matrix400;
  adresse50 = adresse400;

  // Local state
  private readonly bounds = signal<LatLngBoundsLiteral>([[45.1, 5.6], [45.3, 5.9]]);
  protected readonly options: MapOptions = {
    zoom: 11,
    center: latLng(45.188529, 5.724524),
  };

  // 🔥 PAR DÉFAUT, ON CHARGE adresse50 AU LIEU DE localStorage
  private readonly _adresses = signal<readonly Adresse[]>(adresse400);
  
  private readonly _optimizationResult: WritableSignal<undefined | OptimizationResult>;
  private readonly _routes = signal<ReadonlyArray<ReadonlyArray<LatLngTuple>>>(
    localStorage.getItem(lastRoutesKey) ? JSON.parse(localStorage.getItem(lastRoutesKey)!) : []
  );

  protected readonly layers: Signal<Layer[]>;
  
  private readonly colors = [
    '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF',
    '#00FFFF', '#FF8800', '#8800FF', '#00FF88', '#FF0088',
    '#88FF00', '#0088FF', '#FF4400', '#4400FF', '#00FF44',
    '#FF0044', '#44FF00', '#0044FF', '#FFAA00', '#AA00FF',
    '#00FFAA', '#FF00AA', '#AAFF00', '#00AAFF', '#FF2200',
    '#2200FF', '#00FF22', '#FF0022', '#22FF00', '#0022FF'
  ];  

  constructor() {
    const back = tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '...' });
    const bboxRectangle: Signal<Rectangle> = computed<Rectangle>(
      () => rectangle(this.bounds(), { color: 'blue', weight: 1 })
    );
    this.layers = computed<Layer[]>(
      () => [
        back,
        bboxRectangle(),
        ...this._adresses().map((a, i) => getMarker(a, i === this._adresses().length - 1 ? 'black' : 'blue')),
        ...this._routes().map((r, i) => polyline([...r], { 
          color: this.colors[i % this.colors.length],
          weight: 4,
          opacity: 0.8,
          smoothFactor: 1
        }))
      ]
    );

    const lastOptStr = localStorage.getItem(lastOptimizationResponseKey);
    this._optimizationResult = signal<undefined | OptimizationResult>(
      lastOptStr && lastOptStr !== "undefined" ? JSON.parse(lastOptStr) : undefined
    );

    // Sauvegarder les changements
    effect(() => localStorage.setItem(lastAdressesKey, JSON.stringify(this._adresses())));
    effect(() => {
      const opt = this._optimizationResult();
      console.log("Optimization :", opt);
      localStorage.setItem(lastOptimizationResponseKey, JSON.stringify(opt));
    });
    effect(() => localStorage.setItem(lastRoutesKey, JSON.stringify(this._routes())));
  }

  // 🔥 EXACTEMENT COMME LA PHOTO - ngOnInit AVEC LA BOUCLE
  ngOnInit() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 CHARGEMENT PAR DÉFAUT - DATASET 50');
    console.log('='.repeat(80));
    
    console.log(`📍 Parking: ${this.adresse50[this.adresse50.length - 1].name}`);
    console.log(`📦 Points à livrer: ${this.adresse50.length - 1}`);
    console.log(`✅ Total adresses: ${this._adresses().length}\n`);
    
    // 🔥 LA BOUCLE EXACTEMENT COMME LA PHOTO
    for(let i = 0; i < this.matrice100.distances.length; i++) {
      console.log(this.matrice100.distances[i]);
    }
    
    console.log('\n✅ Matrice affichée: ' + this.matrice100.distances.length + ' lignes');
  }

  // 🔥 PLUS BESOIN DE BOUTON - C'EST LE DÉFAUT !

  /**
   * Filtre les adresses inaccessibles
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
      const MAX_SNAPPED_DISTANCE = 150;
      
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
      
      this._adresses.set(accessibleAddresses);
      console.log(`✅ ${accessibleAddresses.length}/${allAddresses.length} addresses are accessible`);
      
      return removedCount;
      
    } catch (err) {
      console.error('❌ Error checking accessibility:', err);
      throw err;
    }
  }

  /**
   * Génère un nombre donné d'adresses aléatoires
   */
  protected async generateAdresses(nb: number): Promise<void> {
    const bounds = this.bounds();
    const southWest = bounds[0];
    const northEast = bounds[1];

    this._adresses.set([]);
    this._routes.set([]);
    this._optimizationResult.set(undefined);
    
    let remaining = nb;

    console.log(`🎯 Target: ${nb} addresses\n`);

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

    const removedCount = await this.filterInaccessibleAddresses();
    
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

    this.downloadAdressesJson(this._adresses().length);
    await this.downloadMatrix(this._adresses().length);
  }

  /**
   * Optimisation des routes
   */

protected optimizeRoutesSweepe(
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

  protected async optimizeRoutesEquitable(
    nbVehicules: number,
    maxTimePerVehicule: number,
    
  ): Promise<void> {
    let adresses=this._adresses();
    this._routes.set([]);
    if ( adresses.length === 0) {
      console.warn('No addresses to optimize.');
      return;
    }
    
    this._srvCarto.optimizeAndExport(
      adresses,
      nbVehicules,
      maxTimePerVehicule
    ).then(
      async (results) => {
        if (results.length > 0) {
          this._optimizationResult.set(results[0]);
          
          const allRoutes = await Promise.all(
            results.flatMap(result => 
              result.routes.map(route => 
                this._srvCarto.getDirections(route.steps.map(s => s.location))
              )
            )
          );
          
          this._routes.set(allRoutes);
          console.log(`\n🗺️ ${allRoutes.length} tracé(s) affiché(s) sur la carte (${results.length} paquets)`);
        }
        return [];
      }
    ).catch(
      err => {
        console.error('Optimization error:', err);
        this._optimizationResult.set(undefined);
      }
    );
  }

  /**
   * Télécharge les adresses au format JSON
   */
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

  /**
   * Télécharge la matrice de distances
   */
  private async downloadMatrix(nb: number): Promise<void> {
    try {
      const matrixResult = await this._srvCarto.getDistanceMatrix(this._adresses());
      
      const avgSnappedDistance = matrixResult.sources.reduce((sum: number, s: any) => sum + s.snapped_distance, 0) / matrixResult.sources.length;
      console.log(`Average snapped distance: ${avgSnappedDistance.toFixed(2)}m`);
      
      if (avgSnappedDistance > 100) {
        console.warn('⚠️ High snapped distances detected!');
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




  protected async optimizeRoutesAndAppend(
  nbVehicules: number,
  maxTimePerVehicule: number,
  adresses: readonly Adresse[]
): Promise<void> {

  const previousRoutes = this._routes();

  // appel SANS modifier optimizeRoutes
  this.optimizeRoutesSweepe(nbVehicules, maxTimePerVehicule, adresses);

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
