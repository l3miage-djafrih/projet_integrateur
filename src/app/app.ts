import { Component, computed, inject, Signal, signal, WritableSignal } from '@angular/core';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { latLng, LatLngBoundsLiteral, LatLngTuple, Layer, MapOptions, polyline, Rectangle, rectangle, tileLayer } from 'leaflet';
import { Carto } from './services/carto';
import { getMarker } from './utils/marker';
import { FormsModule } from '@angular/forms';
import { Adresse } from './data/adresse';
import { OptimizationResult } from './services/OptimizationResult';
import { adresse100 } from './data/dataSet100Adresses/adresse_96_complete';
import { matrix100 } from './data/dataSet100Adresses/matrix_96_complete';

@Component({
  selector: 'app-root',
  imports: [FormsModule, LeafletModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {

  private readonly _srvCarto = inject(Carto);

  private readonly bounds = signal<LatLngBoundsLiteral>([[45.1, 5.6], [45.3, 5.9]]);

  protected readonly options: MapOptions = {
    zoom: 11,
    center: latLng(45.188529, 5.724524),
  };

  // 🔥 DONNÉES UNIQUEMENT DEPUIS LE FICHIER
  private readonly _adresses = signal<readonly Adresse[]>(adresse100);

  private readonly _optimizationResult: WritableSignal<undefined | OptimizationResult> =
    signal(undefined);

  private readonly _routes = signal<ReadonlyArray<ReadonlyArray<LatLngTuple>>>([]);

  protected readonly layers: Signal<Layer[]>;
  private readonly colors = ['red', 'green', 'blue', 'orange', 'cyan','purple','pink'];

  constructor() {
    const back = tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 });

    const bboxRectangle: Signal<Rectangle> = computed(() =>
      rectangle(this.bounds(), { color: 'blue', weight: 1 })
    );

    this.layers = computed(() => [
      back,
      bboxRectangle(),
      ...this._adresses().map((a, i) =>
        getMarker(a, i === this._adresses().length - 1 ? 'black' : 'blue')
      ),
      ...this._routes().map((r, i) =>
        polyline([...r], { color: this.colors[i % this.colors.length] })
      )
    ]);
  }

  // ================================
  // 🔴 FONCTIONS DÉSACTIVÉES
  // ================================

  protected async generateAdresses(nb: number): Promise<void> {
    console.log("⚠️ Génération désactivée : dataset chargé depuis fichier.");
  }

  private async filterInaccessibleAddresses(): Promise<number> {
    console.log("⚠️ Filtrage désactivé : dataset déjà propre.");
    return 0;
  }

  private downloadAdressesJson(nb: number): void {
    console.log("⚠️ Export désactivé.");
  }

  private async downloadMatrix(nb: number): Promise<void> {
    console.log("⚠️ Export matrice désactivé.");
  }

  // ================================
  // OPTIMISATION (ACTIVE)
  // ================================

  protected async optimizeRoutes(
    nbVehicules: number,
    maxTimePerVehicule: number
  ): Promise<void> {

    const adresses = this._adresses();

    if (adresses.length === 0) {
      console.warn('No addresses.');
      return;
    }

    const parking = adresses.at(-1)!;
    const deliveries = adresses.slice(0, -1);

    console.log('🚀 Optimization using preloaded dataset');

    const optimizedRoutes = await this._srvCarto.optimizeAdvanced({
      nbVehicules,
      maxTimePerVehicule,
      adresses: deliveries,
      parking,
      preCalculatedMatrix: {
        distances: matrix100.distances,
        durations: matrix100.durations
      }
    });

    this._optimizationResult.set(optimizedRoutes[0]);

    const allDirections: ReadonlyArray<LatLngTuple>[] = [];

    for (const routeResult of optimizedRoutes) {
      if (routeResult.routes.length > 0) {
        const directions = await this._srvCarto.getDirections(
          routeResult.routes[0].steps.map(s => s.location)
        );
        allDirections.push([...directions] as LatLngTuple[]);
      }
    }

    this._routes.set(allDirections);
  }
}
