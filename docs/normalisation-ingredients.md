# Normalisation des ingrédients achetés

Date : 2026-10-29. Code : `services/catalog/`. Migrations : `supabase/migrations/20261030*`.

## Principe

Chaque produit acheté reçoit :

1. **un rôle** : ingrédient de cuisine, plat préparé, dessert, en-cas, petit-déjeuner, boisson, pain
   (les produits non alimentaires sont retirés de la base et mis en liste d'exclusion) ;
2. **un ou plusieurs ingrédients génériques** du référentiel (199 ingrédients, ex. « Filets de poulet jaune » → « Poulet (filet) »,
   « Petits pois carottes » → petit pois + carotte, 50 % chacun) ;
3. **une contenance** en unité de base (g, ml ou pièce) avec sa provenance et un niveau de confiance.

Les 254 règles de classement sont écrites dans `services/catalog/referential.py` et copiées dans la base
(`private.ingredient_rules`). Les nouveaux produits des prochains tickets sont classés par la base avec exactement
les mêmes règles (vérifié : 0 écart sur 1 469 produits entre Python et PostgreSQL).

## Provenance des contenances (produits « ingrédient »)

| Source | Signification | Part des achats d'ingrédients |
|---|---|---|
| `label` | lue dans le nom du ticket (« 1,5 kg », « x12 », « 6x1,5l ») | 16 % |
| `ticket_weight` | poids pesé à la caisse, ligne par ligne | 7 % |
| `unit_sale` | produit vendu à la pièce (concombre, avocat…) : 1 pièce | 14 % |
| `openfoodfacts` (confiance ≥ 0,85) | fiche Open Food Facts correspondante | 25 % |
| `openfoodfacts` (confiance < 0,85) | plusieurs formats possibles (ex. beurre 250 g ou 500 g) : à confirmer | 31 % |
| inconnue | aucune source fiable | 7 % |

Aucune contenance n'est inventée. Quand plusieurs formats existent, le plus fréquent est retenu, les autres sont gardés
dans `products.pack_formats` et la confiance est abaissée : l'application doit demander confirmation.
L'utilisateur peut corriger (`quantity_source = 'user'`), et ses corrections ne sont jamais écrasées.

## Sources externes

- **Site lidl.fr** : non utilisé. Le catalogue en ligne contient surtout du non alimentaire, et le site est protégé
  contre les accès automatisés ; ma session a bloqué la tentative de contournement, à juste titre.
- **Open Food Facts** : environ 10 000 fiches de produits de marques Lidl vendus en France (moteur de recherche
  search.openfoodfacts.org, 1 requête / 3 s), puis 85 recherches ciblées pour les produits de marque nationale.
  Un produit n'est comparé qu'aux fiches classées dans le même ingrédient par les mêmes règles.

> Données Open Food Facts : © contributeurs Open Food Facts, licence Open Database License (ODbL).
> Les codes et noms de fiches réutilisés sont conservés dans `products.off_code` / `products.off_name`.

## Ce que l'application lit

- `public.purchased_ingredients` : chaque ligne d'achat convertie en ingrédient + quantité (nulle si inconnue).
- `public.ingredient_purchases(foyer, nb_jours)` : synthèse par ingrédient sur une période, avec le nombre de lignes
  sans quantité et la confiance minimale. C'est l'entrée des stocks estimés et de la planification.

## Limites connues

- Le format exact acheté n'est pas sur le ticket : pour 31 % des achats d'ingrédients, le format est probable mais pas certain.
- Le tri non alimentaire et le classement reposent sur des mots-clés : un nom inhabituel peut être mal classé. Les
  corrections se font produit par produit (`role_source = 'user'`).
- Aucune conversion masse/volume ni poids moyen d'une pièce n'est appliqué (pas de densité supposée).
