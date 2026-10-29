# Suivi des tâches

| Phase | Statut | Notes |
|---|---|---|
| 1. Audit du connecteur Lidl Plus | **Largement fait** | Prototype réel réussi (voir `docs/phase1-resultats-prototype.md`). Reste à mesurer : durée de vie du token, appel depuis un téléphone. |
| 2. Fondations | En cours | Projet Supabase créé, schéma des achats et RLS appliqués (`supabase/migrations`). Application mobile (Expo) pas encore créée. |
| 3. Référentiel produits et recettes | Partiel | Produits des tickets en base (noms relus avec l'utilisateur). Ingrédients et recettes à faire. |
| 4. Synchronisation des tickets | Partiel | Parseur et import testés sur 158 tickets. Synchro automatique depuis le téléphone à faire. |
| 5. Stocks | À faire | |
| 6. Mistral et recettes | À faire | Inclut le tri non alimentaire complet. |
| 7. Planification | À faire | |
| 8. Préférences et équilibre | À faire | |
| 9. Liste de courses | À faire | |
| 10. Finalisation | À faire | |

## À traiter ensuite
- 8 noms de produits encore « à confirmer » (vue `products_to_confirm`).
- Migration `20261029000003` : la seconde passe de suppression par mots-clés a été appliquée directement, voir le commentaire du fichier.
- Porter le parseur (`services/lidl/lidl_parse.py`) en TypeScript pour l'application.
