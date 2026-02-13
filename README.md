# Algorithme de Clustering par Angle (Sweeper Algorithm)
## pré requis 
Cette Algorithme requiert l'installation de la bibliothèque Turf.js :
npm install turf

## 1. Étape : Transformation des clients en angles
Chaque client est transformé en un angle par rapport au parking :
```typescript
dx = latClient - latParking
dy = lngClient - lngParking
angle = atan2(dy, dx)
        angle=atan2(dy,dx)
```


## 2éme étape normalisation et trie par ordre croissant :
   On obtient une liste d'angles pour chaque client que l'on normalise afin que le tri croissant génère une liste d'adresses proches les unes des autres 

## 3éme étape:
   On coupe la liste des adresses triées par ordre croissant en secteurs circulaires, ce qui représente des "chunks", tout en respectant la contrainte de 50 adresses par chunk, conformément aux limites de l'API

# Génration des routes optimisées 
 aprés la génération des chunks d'adresses on parcours chaque chunk et on effectue un appel api d'optimisation par chunk ,en affectant n<=3, livreurs par chunk ,


