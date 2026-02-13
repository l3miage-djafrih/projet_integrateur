# Semaine 2 : Groupe N°12  
Membres du groupe :  
DJAFRI Halim   
BENTAHA Ahcene   
DID Abderahmane  
BENKHENNOUCHE Dihya  
BOUAMARA Celia  
BELKHATAB Maria  


## Phase 1 :   
### Les limites d’OpenRouteService (ORS) :   
L’utilisation de l’API OpenRouteService (ORS) est soumise à plusieurs contraintes techniques :  
- Calcul de la matrice temps–distance :  
→ maximum 50 adresses par requête.  
- Nombre de véhicules de livraison :  
→ maximum 3 véhicules.  
- Nombre d’adresses optimisables (Optimization API) :  
→ maximum 50 adresses.  
- Nombre de requetes :  
→ 40 requetes par minute.  

### La génération des jeux de données :  
Pour générer les jeux de données, nous utilisons l’API fournie dans l’amorce du code (API Gouv, nom exact à préciser).  
Cette API permet de générer des points de livraison dans une zone géographique bien déterminée. Cependant :  
Les adresses générées sont uniquement :  
- stockées dans le localStorage du navigateur,  
- affichées sur la carte.  
Elles ne sont pas automatiquement sauvegardées sous forme de fichiers exploitables.  
Pour résoudre ce problème, nous avons créé une méthode :  

```Typescript
downloadAdressesJson(nb: number)
```

Cette méthode :
- récupère le signal _adresses, qui contient la liste des adresses générées,
- permet de sauvegarder ces adresses dans un fichier JSON.  
Elle fonctionne pour : 50 adresses, 100 adresses, 400 adresses.  
Les fichiers générés sont disponibles dans le dossier : `src/app/data` (les fichiers adresses).  


### Filtrage des adresses :  
Après la génération des jeux de données, nous avons quelques adresses non accessibles, alors on a évité de les stocker dans la matrice, et gardé que les adresses atteignables.  
Cela se fait grâce au calcul de l'attribut snapped distance qui représente la distance entre l'adresse et la route la plus proche, si sa valeur est grande alors on l'enlève de la matrice, c'est pour ça qu'on a moins d'adresses dans les fichiers du dataset :  
50 → 47   
100 → 96    
200 → 187    
400 → 377    


## Phase 2 :  
### Construction de la matrice temps/distance :  
La construction de la matrice se fait à l’aide de l’API Matrix d’ORS.  
#### a/ Cas de 50 points de livraison  
Le calcul fonctionne directement avec un seul appel API.  
Les limites d’ORS ne sont pas dépassées.  
Une matrice 50 × 50 est générée, contenant les distances et les temps de trajet pour toutes les combinaisons possibles de points. Un exemple de la matrice est disponible dans `src/app/data/dataSet50Adresses/matrix_47_complete.ts`  

#### b/ Cas de plus de 50 points de livraison (100, 400, ...)  
Dans ce cas, les limites d’ORS sont dépassées.  
Il est donc nécessaire d’adopter une stratégie de découpage du problème.  
Principe :  
- Découper la matrice globale en sous-matrices de taille 50 × 50.  
- Appliquer l’API ORS sur chacune de ces sous-matrices.  
Pour 100 points, on obtient 4 sous-matrices :  
M1 : [0..49] × [0..49]  
M2 : [0..49] × [50..99]  
M3 : [50..99] × [0..49]  
M4 : [50..99] × [50..99]  
Cela nécessite 4 appels API, puis une reconstruction de la matrice complète.  
Pour 400 points, on obtient 64 sous-matrices donc cela nécessite 64 appels API.  
Des exemples de matrices sont disponible dans le dossier `src/app/data` (les fichiers matrix).  


### Les stratégies suivies pour casser la complexité :  
Afin de casser les limites d'ORS, on a suit la stratégie de découpage pour l'API Matrix et on a réussi à construire des matrices temps distances pour plus de 50 points de livraison, et pour l'API d'optimisation, on a défini 3 stratégies, chacune est implémentée avec un algorithme spécéfique, ils sont expliqués en détails ci-dessous :  

### Les algorithmes à utiliser pour résoudre le problème :  
#### Algo 1 : Algorithme de Clustering par Angle (Sweeper Algorithm)  
##### Pré-requis :  
Cet Algorithme requiert l'installation de la bibliothèque Turf.js :  
`npm install turf`    

##### 1ère étape : Transformation des clients en angles  
Chaque client est transformé en un angle par rapport au parking :  
```typescript
dx = latClient - latParking
dy = lngClient - lngParking
angle = atan2(dy, dx)
        angle=atan2(dy,dx)
```


##### 2éme étape : Normalisation et tri par ordre croissant :  
On obtient une liste d'angles pour chaque client que l'on normalise afin que le tri croissant génère une liste d'adresses proches les unes des autres.  

##### 3éme étape :  
On coupe la liste des adresses triées par ordre croissant en secteurs circulaires, ce qui représente des "chunks", tout en respectant la contrainte de 50 adresses par chunk, conformément aux limites de l'API  
- Génration des routes optimisées :  
Aprés la génération des chunks d'adresses on parcours chaque chunk et on effectue un appel api d'optimisation par chunk, en affectant n<=3, livreurs par chunk.  
- Méthode d'optimization :  
L’algorithme d’optimisation optimizationSweeper optimise le critère du nombre de véhicules.  
En parcourant chaque chunk, il affecte 1 livreur.  
Si tous les colis ont pu être livrés, on passe au chunk suivant.  
Sinon, il affecte 2 livreurs, puis 3.  
S’il y a besoin de plus de 3 livreurs, le chunk est ignoré et on passe au suivant.  


#### Algo 2 : Répartition équitable des tournées  
Stratégie de l'algorithme :  
##### Vérification de faisabilité :  
L'algorithme commence par vérifier si le nombre de véhicules demandés est suffisant pour livrer tous les points, en respectant la limite de 50 points par paquet et 3 véhicules par paquet. Si le nombre de véhicules demandés est insuffisant, l'algorithme retourne une erreur et conseille d'augmenter le nombre de véhicules.  
##### Calcul de la distribution équitable des points :  
Le nombre total de points est réparti entre les véhicules de manière aussi équitable que possible. Si le nombre total de points n'est pas divisible de manière parfaite, certains véhicules peuvent recevoir un point supplémentaire pour compenser le reste.  
Cela garantit que chaque véhicule aura un nombre similaire de points à livrer, avec une différence maximale de 1 point entre les véhicules.  
##### Regroupement des adresses par véhicule :  
Après avoir réparti les points entre les véhicules, les adresses sont triées par longitude, puis chaque véhicule se voit attribuer un certain nombre d'adresses. Les points sont regroupés pour éviter de dépasser la limite de 50 points par paquet et 3 véhicules par paquet.  
Si un véhicule dépasse ces limites, l'algorithme ajuste et crée un nouveau paquet d'adresses.  
##### Optimisation du parcours :  
Une fois les points distribués, l'algorithme envoie chaque paquet d'adresses à l'optimisation pour obtenir un plan de livraison optimal, en prenant en compte la durée du trajet, la distance et le temps de livraison. L'optimisation vise à minimiser le coût et la durée de chaque livraison.  
L'algorithme utilise des appels ORS (optimisation des tournées) pour calculer les itinéraires les plus efficaces.  
Après l'optimisation, un rapport détaillé est généré, indiquant les statistiques des livraisons effectuées (nombre de points livrés, véhicules utilisés, coût total, durée totale, alertes éventuelles).Si des points restent non livrés, des recommandations sont données pour améliorer l'optimisation (par exemple, augmenter le nombre de véhicules ou le temps alloué par véhicule).  


#### Algo 3 : K-Medoids clustering  
##### Un petit schéma (récapitulatif) de l'algo :  
```
Adresses JSON → Matrice pré-calculée → K-Medoids clustering  
                        ↓  
        Clusters (groupes d'adresses par véhicule)  
                        ↓  
        Appels ORS par cluster → Routes optimisées  
                        ↓  
        Directions (polylines) → Affichage carte  
```  
##### K-Medoids en bref  
1. Divise les adresses en k clusters (k = nombre de véhicules)  
2. Utilise les durées de trajet (pas les distances GPS)  
3. Chaque cluster = 1 véhicule = 1 route optimisée  
##### Données (entrées) :  
- Adresses + parking chargés depuis fichiers JSON  
- Matrice de durées pré-calculée → évite les appels API répétés  
##### Sorties :  
- Routes optimisées affichées sur la carte (polylines colorées)  
- Stats : adresses livrées, taux de réussite, routes créées  


## Phase 3 :  
### Implémentation des algorithmes :  
On a implémenté ces 3 algorithmes mais ils marchent pas parfaitement, il y a quelques nuances qu'on arrive pas à résoudre en une semaine mais on va les améliorer prochainement, voici une petite explication :  
- Soit il construit des tournées selon le nombre de clusters disponibles, et donc il prend pas en consédération le nombre de véhicules, en ce cas là pour pouvoir effectuer toutes les tournées, chaque véhicule doit prendre au moins une tournée (le but c'est de ne pas laisser une tournée sans véhicule).
- Soit il construit des tournées selon le nombre de véhicules, en ce cas là toutes les tournées sont affectées, mais chacune possède au maximum 50 adresses, si par exemple on a 200 adresses et 3 véhécules, il va prendre 150 seulement et laisser 50.  
