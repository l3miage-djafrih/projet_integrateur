
## Fonctionnalités

- **Génération automatique d'adresses** dans une zone géographique définie
- **Filtrage des adresses inaccessibles** (trop éloignées du réseau routier)
- **Optimisation intelligente des tournées** avec clustering géographique
- **Visualisation interactive** des routes sur carte Leaflet
- **Calcul automatique** du nombre optimal de véhicules
- **Export des données** (adresses et matrices de distances)


### Vue d'ensemble

On utilise une approche en **2 phases** pour résoudre le problème de tournées de véhicules (VRP - Vehicle Routing Problem) :

Phase 1 : AFFECTATION    →    Phase 2 : OPTIMISATION
(Clustering K-means)          (API ORS pour chaque véhicule)


### Phase 1 : Affectation géographique (Clustering K-means)

**Objectif** : Regrouper les adresses en zones géographiques cohérentes, une par véhicule.

**Algorithme** : K-means clustering
- **K** = nombre de véhicules demandés
- **Entrée** : Liste d'adresses avec coordonnées (lat, lng)
- **Sortie** : K clusters géographiques


**Exemple** :

150 adresses + 5 véhicules demandés
↓
K-means avec K=5
↓
Cluster 1 (Nord)   : 32 adresses
Cluster 2 (Centre) : 28 adresses
Cluster 3 (Sud)    : 31 adresses
Cluster 4 (Est)    : 29 adresses
Cluster 5 (Ouest)  : 30 adresses


**Ajustements automatiques** :
- Si trop de clusters → fusion des plus petits
- Si pas assez de clusters → division des plus gros
- Résultat : exactement K clusters

### Phase 2 : Optimisation des tournées (API ORS)

**Objectif** : Pour chaque cluster, calculer l'itinéraire optimal du véhicule.

**Pour chaque véhicule** :
1. Appel à l'API avec :
   - Les adresses du cluster
   - Le parking (point de départ/retour)
   - Contrainte de temps max
   - 1 seul véhicule

2. L'API résout le TSP et retourne :
   - Ordre optimal de visite des adresses
   - Durée totale de la tournée
   - Liste des étapes (steps)

3. Calcul de l'itinéraire détaillé (routes sur la carte)

**Avantage** : L'optimisation est locale à chaque zone, donc plus rapide et plus précise.

### Gestion des contraintes

**Contrainte de temps** :
- Si une tournée dépasse le temps max, l'API ORS **ignore** les adresses les plus éloignées
- L'application affiche un avertissement avec les adresses non livrées

### Limitesssss:
- L'algo essaie pas de faire avce un min de véhicule => il fait en fonction du nombre de clusters , par exemple il essaie pas de faire avec moins de véhicules 




