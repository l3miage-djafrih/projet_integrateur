import { Component, computed, inject, Signal, signal, WritableSignal } from '@angular/core';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { latLng, LatLngBoundsLiteral, LatLngTuple, Layer, MapOptions, polyline, Rectangle, rectangle, tileLayer } from 'leaflet';
import { Carto } from './services/carto';
import { OptimizationAdvancedResult, OptimizeAdvancedService } from './services/optimize-advanced';
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
  private readonly _srvOptimizeAdvanced = inject(OptimizeAdvancedService);

  private readonly bounds = signal<LatLngBoundsLiteral>([[45.1, 5.6], [45.3, 5.9]]);

  protected readonly options: MapOptions = {
    zoom: 11,
    center: latLng(45.188529, 5.724524),
  };

  // DONNÉES UNIQUEMENT DEPUIS LE FICHIER
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

    // Choisir entre optimize (simple) et optimizeAdvanced (complexe)
    const useSimpleOptimization = deliveries.length <= 50 && nbVehicules <= 3;

    if (useSimpleOptimization) {
      console.log('🚀 Optimization simple (≤50 adresses, ≤3 véhicules)');
      
      const optimizedRoute = await this._srvCarto.optimize({
        nbVehicules,
        maxTimePerVehicule,
        adresses: deliveries,
        parking
      });

      this._optimizationResult.set(optimizedRoute);

      const allDirections: ReadonlyArray<LatLngTuple>[] = [];

      if (optimizedRoute.routes.length > 0) {
        for (const route of optimizedRoute.routes) {
          const directions = await this._srvCarto.getDirections(
            route.steps.map(s => s.location)
          );
          allDirections.push([...directions] as LatLngTuple[]);
        }
      }

      this._routes.set(allDirections);
    } else {
      console.log('🚀 Optimization avancée (>50 adresses ou >3 véhicules)');

      const result = await this._srvOptimizeAdvanced.optimizeAdvanced({
        nbVehicules,
        maxTimePerVehicule,
        adresses: deliveries,
        parking,
        preCalculatedMatrix: {
          distances: matrix100.distances,
          durations: matrix100.durations
        }
      });

      // Afficher les statistiques
      console.log(`\n📊 Statistiques finales :`);
      console.log(`  ✅ Adresses livrées : ${result.stats.deliveredCount}/${result.stats.totalAddresses}`);
      console.log(`  📈 Taux de réussite : ${result.stats.successRate.toFixed(1)}%`);
      console.log(`  🚛 Routes créées : ${result.stats.totalRoutes}`);
      
      if (result.stats.undeliveredCount > 0) {
        console.warn(`  ⚠️ ${result.stats.undeliveredCount} adresses non livrées`);
      }

      // Stocker le premier résultat pour compatibilité
      if (result.results.length > 0) {
        this._optimizationResult.set(result.results[0]);
      }

      // Récupérer les directions pour toutes les routes
      const allDirections: ReadonlyArray<LatLngTuple>[] = [];

      for (const routeResult of result.results) {
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
}
