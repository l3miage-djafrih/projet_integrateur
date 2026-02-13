import { Adresse } from '../data/adresse';
//import { kmeans } from 'ml-kmeans'; // si tu utilises ml-kmeans ou un algo K-means JS

/**
 * Cluster les adresses en groupes d'environ max 50 adresses
 * @param adresses Liste des adresses à clusteriser
 * @param maxPointsParCluster Nombre max de points par cluster (ex: 50)
 * @returns Liste de clusters (chaque cluster est un tableau d'adresses)
 */

export function clusterAdresses(
  adresses: readonly Adresse[],
  maxPerCluster = 45
): Adresse[][] {

  if (adresses.length <= maxPerCluster) {
    return [ [...adresses] ];
  }

  const K = Math.ceil(adresses.length / maxPerCluster);

  // Initialisation aléatoire des centroïdes
  let centroids = adresses
    .slice(0, K)
    .map(a => ({ lat: a.lat, lng: a.lng }));

  let clusters: Adresse[][] = [];

  for (let iter = 0; iter < 15; iter++) {
    clusters = Array.from({ length: K }, () => []);

    //  Assignation
    for (const a of adresses) {
      let best = 0;
      let bestDist = Infinity;

      for (let i = 0; i < K; i++) {
        const d = dist2(a, centroids[i]);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      clusters[best].push(a);
    }

    //  Recalcul des centroïdes
    centroids = clusters.map(c => ({
      lat: avg(c.map(a => a.lat)),
      lng: avg(c.map(a => a.lng)),
    }));
  }

  return clusters;
}

function dist2(a: Adresse, b: { lat: number; lng: number }) {
  const dx = a.lat - b.lat;
  const dy = a.lng - b.lng;
  return dx * dx + dy * dy;
}

function avg(arr: number[]) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
