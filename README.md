# ProjetDataSynthesis

Cette amorce de code est destinée à être utilisée pour :

1. Synthétiser des listes d'adresses
2. Illustrer l'usage de l'API gouvernementale d'adresses (https://api-adresse.data.gouv.fr/)
3. Illustrer l'usage de l'API openRouteService (https://openrouteservice.org/)
4. Illustrer l'usage de ZOD comme outil de validation de données (https://zod.dev/)

## Notes

Le code source n'est pas destiné à être réutilisé tel quel, mais plutôt à servir de source d'inspiration pour vos projets.

Afin de ne pas dépasser les limites d'utilisation des API, les données récupérées sont stockées autant que possible dans localStorage (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage) et réutilisées lors des exécutions suivantes. Dans le cas de votre projet, ces données pourraient être stockées côté serveur.

## Suggestions

* Explorer la récupération des matrices de distances et de temps de parcours entre les adresses synthétisées, en utilisant l'API openRouteService.
* Utiliser ZOD pour valider les données récupérées des API, en s'assurant qu'elles correspondent aux formats attendus.
* Explorer des stratégies pour casser les données du problème. Vous devriez être en mesure de gérer des centaines de points de livraisons et une dizaine de véhicules.