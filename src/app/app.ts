import { Component, computed, effect, inject, Signal, signal, WritableSignal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LeafletModule } from '@bluehalo/ngx-leaflet';
import { latLng, LatLngBoundsLiteral, LatLngTuple, Layer, MapOptions, Marker, polyline, Rectangle, rectangle, tileLayer } from 'leaflet';
import { Carto } from './services/carto';
import { getMarker } from './utils/marker';
import { FormsModule } from '@angular/forms';
import { Adresse } from './data/adresse';
import { OptimizationResult } from './services/OptimizationResult';
import { clusterAdresses } from './services/clustering';


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
  private readonly bounds = signal<LatLngBoundsLiteral>([[45.1, 5.6], [45.3, 5.9]]);
  protected readonly options: MapOptions = {
    zoom: 11,
    center: latLng(45.188529, 5.724524),
  };

  private readonly _adresses = signal<readonly Adresse[]>(
    localStorage.getItem(lastAdressesKey) ? JSON.parse(localStorage.getItem(lastAdressesKey)!) : []
  );
  private readonly _optimizationResult: WritableSignal<undefined | OptimizationResult>;
  private readonly _routes = signal<ReadonlyArray<ReadonlyArray<LatLngTuple>>>(
    localStorage.getItem(lastRoutesKey) ? JSON.parse(localStorage.getItem(lastRoutesKey)!) : []
  );

  //générer des couleurs 
  getColor(index: number): string {
  const hue = (index * 137.508) % 360; // angle doré
  return `hsl(${hue}, 70%, 50%)`;
  }
  protected readonly layers: Signal<Layer[]>;
private readonly colors = [
  'red', 'green', 'blue', 'orange', 'cyan', 'purple',
  'pink', 'yellow', 'brown', 'lime', 'teal', 'magenta',
  'gold', 'navy', 'olive', 'coral', 'salmon', 'turquoise',
  'indigo', 'violet', 'chartreuse', 'crimson', 'darkgreen',
  'darkblue', 'darkorange', 'deeppink', 'dodgerblue',
  'forestgreen', 'hotpink', 'lightseagreen', 'mediumvioletred'
];  //private readonly colors = this.getColor();
  
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
        ...this._routes().map((r, i) => polyline([...r], { color: this.colors[i % this.colors.length] }))
      ]
    );

    const lastOptStr = localStorage.getItem(lastOptimizationResponseKey);
    this._optimizationResult = signal<undefined | OptimizationResult>(
      lastOptStr && lastOptStr !== "undefined" ? JSON.parse(lastOptStr) : undefined
    );

    effect(() => localStorage.setItem(lastAdressesKey, JSON.stringify(this._adresses())));
    effect(() => {
      const opt = this._optimizationResult();
      console.log("Optimization :", opt)
      localStorage.setItem(lastOptimizationResponseKey, JSON.stringify(opt))
    });
    effect(() => localStorage.setItem(lastRoutesKey, JSON.stringify(this._routes())));
  }

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

  // ═══════════════════════════════════════════════════════
  // NOUVELLE STRATÉGIE D'OPTIMISATION
  // ═══════════════════════════════════════════════════════

  /**
   * Affecte les adresses aux véhicules (clustering géographique)
   */
  private assignAddressesToVehicles(
    adresses: readonly Adresse[],
    nbVehicules: number
  ): Adresse[][] {

    if (nbVehicules === 1) {
    return [[...adresses]];
    }
    
    const clusters = clusterAdresses(adresses, Math.ceil(adresses.length / nbVehicules));
    
    // Ajuster pour avoir exactement nbVehicules clusters
    while (clusters.length > nbVehicules) {
      clusters.sort((a, b) => a.length - b.length);
      const smallest1 = clusters.shift()!;
      const smallest2 = clusters.shift()!;
      clusters.push([...smallest1, ...smallest2]);
    }
    
    while (clusters.length < nbVehicules) {
      clusters.sort((a, b) => b.length - a.length);
      const biggest = clusters.shift()!;
      const mid = Math.floor(biggest.length / 2);
      clusters.push(biggest.slice(0, mid), biggest.slice(mid));
    }
    
    return clusters;
  }

  /**
   * Optimise la tournée d'un véhicule
   */
  private async optimizeOneVehicle(
    adresses: Adresse[],
    parking: Adresse,
    maxTimeSec: number
  ): Promise<ReadonlyArray<LatLngTuple>> {
    
    const opt = await this._srvCarto.optimize({
      nbVehicules: 1,
      maxTimePerVehicule: maxTimeSec,
      adresses: adresses,
      parking
    });

    return this._srvCarto.getDirections(
      opt.routes[0].steps.map(s => s.location)
    );
  }

  /**
   * Optimisation complète
   */
  protected async optimizeRoutesScaled(nbVehicules: number, maxTimeMinutes: number): Promise<void> {
    const adresses = this._adresses();
    if (adresses.length === 0) return;

    const parking = adresses.at(-1)!;
    const adressesToDeliver = adresses.slice(0, -1);
    const maxTimeSec = maxTimeMinutes * 60;

    // Phase 1 : Affectation
    const vehicleAssignments = this.assignAddressesToVehicles(adressesToDeliver, nbVehicules);

    // Phase 2 : Optimisation
    const allRoutes: ReadonlyArray<LatLngTuple>[] = [];

    for (const assignments of vehicleAssignments) {
      try {
        const route = await this.optimizeOneVehicle(assignments, parking, maxTimeSec);
        allRoutes.push(route);
      } catch (err) {
        console.error('Erreur optimisation:', err);
      }
    }

    this._routes.set(allRoutes);
  }

  // ═══════════════════════════════════════════════════════
  // FONCTIONS UTILITAIRES
  // ═══════════════════════════════════════════════════════

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

  private async downloadMatrix(nb: number): Promise<void> {
    try {
      const matrixResult = await this._srvCarto.getDistanceMatrix(this._adresses());
      
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
}