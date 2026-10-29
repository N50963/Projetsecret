# Suivi des tâches

| Phase | Statut | Notes |
|---|---|---|
| 1. Audit du connecteur Lidl Plus | **Largement fait** | Prototype réel réussi (voir `docs/phase1-resultats-prototype.md`). Reste à mesurer : durée de vie du token, appel depuis un téléphone. |
| 2. Fondations | En cours | Projet Supabase créé, schéma des achats et RLS appliqués (`supabase/migrations`). Application mobile (Expo) pas encore créée. |
| 3. Référentiel produits et recettes | **Fait** | 215 ingrédients (allergènes), 269 règles, contenances (ticket + Open Food Facts) ; base de 84 recettes versionnées (`docs/base-recettes.md`). |
| 4. Synchronisation des tickets | **Module fait** | Module TypeScript testé (parité 158 tickets, essai réel). Reste : écran, tâche de fond Expo, essai sur téléphone. |
| 5. Stocks | À faire | |
| 6. Mistral et recettes | À faire | Validation des recettes prête (`validateRecipe`). Inclut le tri non alimentaire complet. |
| 7. Planification | À faire | |
| 8. Préférences et équilibre | En cours | Préférences du foyer enregistrées (`household_preferences`) : 2 adultes, 1 ado, 1 enfant ; pas d'allergie ; ni abats ni coquillages ; rien d'épicé ; 1 à 2 dîners sans viande par semaine. Reste : les appliquer aux propositions. |
| 9. Liste de courses | À faire | |
| 10. Finalisation | À faire | |

## À traiter ensuite
- Produits « à confirmer » restants (vue `products_to_confirm`) : anciens achats sans intérêt pour les menus (boisson, panier anti-gaspillage, 2022-2023).
- Appliquer `household_preferences` dans `recipe_candidates` : 8 recettes contiennent du curry, du piment ou du chorizo (curry de poulet, chili, poulet basquaise…) ; les exclure ou proposer une version douce.
- Courses une fois par semaine, presque tout chez Lidl, viande et poisson mangés dans la semaine : la fenêtre de 7 jours des propositions est adaptée.
- Migration `20261029000003` : la seconde passe de suppression par mots-clés a été appliquée directement, voir le commentaire du fichier.
- Formats de produits : 41 confirmés par le foyer (15 % des achats d'ingrédients) ; restent 7 % de formats incertains (124 produits peu achetés) et 15 % sans contenance connue (surtout le pain, les gnocchis).
- Créer le projet Expo et brancher les modules `lidl-sync` et `recipes`.
