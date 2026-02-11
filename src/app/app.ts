import { Component, computed, effect, inject, Signal, signal, WritableSignal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { latLng, LatLngBoundsLiteral, LatLngTuple, Layer, MapOptions, Marker, polyline, Rectangle, rectangle, tileLayer } from 'leaflet';
import { Carto } from './services/carto';
import { getMarker } from './utils/marker';
import { FormsModule } from '@angular/forms';
import { Adresse } from './data/adresse';
import { OptimizationResult } from './services/OptimizationResult';
import { matrix50 } from './data/matrix_50_complete';
import { adresse50 } from './data/adresses_50.json';
import { consoleMatrix, Matrice } from './data/Matrice';

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

  // Local state
  private readonly bounds = signal<LatLngBoundsLiteral>([[45.1, 5.6], [45.3, 5.9]]); // Rectangle autour de Grenoble
  // Options de la carte Leaflet, à conserver en tant que constante car c'est ainsi que la bibliothèque gère cette entrée... 
  // (une erreur de leur part)
  protected readonly options: MapOptions = {
    zoom: 11,
    center: latLng(45.188529, 5.724524), // Coordonnée de Grenoble
  };

  private readonly _adresses = signal<readonly Adresse[]>(
    localStorage.getItem(lastAdressesKey) ? JSON.parse(localStorage.getItem(lastAdressesKey)!) : []
  );
  private readonly _optimizationResult: WritableSignal<undefined | OptimizationResult>;
  private readonly _routes = signal<ReadonlyArray<ReadonlyArray<LatLngTuple>>>(
    localStorage.getItem(lastRoutesKey) ? JSON.parse(localStorage.getItem(lastRoutesKey)!) : []
  );

  // Les différentes couches de la carte Leaflet,
  // sous forme de signal car elles peuvent évoluer au cours du temps
  // On doit malheureusement transmettre des tableaux mutables...
  // Encore une erreur des concepteurs de cette bibliothèque...
  protected readonly layers: Signal<Layer[]>;
  private readonly colors = ['red', 'green', 'blue', 'orange',  'cyan'];
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
  protected async generateAdresses(nb: number): Promise<void> {
    const bounds = this.bounds();
    const southWest = bounds[0];
    const northEast = bounds[1];

    this._adresses.set([]);
    this._routes.set([]);
    this._optimizationResult.set(undefined);
    let remaining = nb;

    // Boucle tant qu'on a pas le bon nombre d'adresse ?
    while (remaining > 0) {
      const points = Array.from({ length: remaining }, () => ({
        lat: Math.random() * (northEast[0] - southWest[0]) + southWest[0],
        lng: Math.random() * (northEast[1] - southWest[1]) + southWest[1],
      }));
      await this._srvCarto.getAdressesFromCoordinates(points).then((adresses) => {
        // Il faut filtrer les adresses "not found"
        console.log('Adresses fetched:', adresses);
        this._adresses.update(L => [...L, ...adresses]);
        remaining = nb - this._adresses().length;
        console.log('Remaining:', remaining);
      });
    }
    console.log(`All ${nb} addresses generated.`);

    //appelle a la fonction downloadAdressesJson() pour telecharger les datasets
    if (remaining === 0) {
      this.downloadAdressesJson(nb);
    }
  }

  /**
   * Optimization of the routes with the given number of vehicles.
   * The steps are provided by the adresses signal attribute.
   */
  protected optimizeRoutes(
    nbVehicules: number,
    maxTimePerVehicule: number
  ): void {
    const adresses = this._adresses();
    if (adresses.length === 0) {
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
  //fonction downloadAdressesJson() pour pour enregistrer les datasets dans un fichiers puis les telecharger
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

  _maMatrix=matrix50;
  _adressesList=adresse50



  ngOnInit(){
    console.log(this._maMatrix);
    console.log(this._adressesList);
  }
  
  


}
