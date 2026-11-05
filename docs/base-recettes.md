# Base de recettes

Code : `services/recipes/` (jeu initial, contrôles), `app/src/modules/recipes/` (module de l'application).
Données : `data/recipes/seed.json` (généré). Migrations : `supabase/migrations/20261030000004_recipes.sql`,
`…05_referential_seed_v2.sql`, `…06_recipes_seed.sql` (générées), `…07_product_ingredients_policies.sql`.

## Dimensionnement pour la cible : un dîner par jour, un déjeuner de temps en temps

| Hypothèse | Valeur |
|---|---|
| Repas à planifier par mois | ≈ 30 dîners + 4 déjeuners = 34 |
| Recette déjà servie exclue pendant | 21 jours (≈ 24 recettes écartées à tout moment) |
| Propositions par repas | 2 à 3, plus une seconde série si refus : ≥ 6 recettes éligibles |
| Part des recettes de saison | ≈ 65 % |
| Part réalisable avec les achats récents (≤ 2 ingrédients manquants) | ≈ 35 % |
| Part compatible avec le temps disponible un soir de semaine | ≈ 60 % |

Recettes nécessaires hors répétition : 6 / (0,65 × 0,35 × 0,6) ≈ 44, plus les 24 récemment servies : **≈ 70 au minimum**.
Le jeu initial en compte **297** (300 avec les 3 recettes ajoutées par le foyer) : 84 recettes de départ, 60 plats du
quotidien ajoutés le 2026-11-01 (`services/recipes/seed_quotidien.py` : cordon bleu et haricots verts, raclette,
tartiflette, blanquette de veau, pot-au-feu, pizza reine, quiches, gratins, soupes…), puis 153 recettes le 2026-11-05 :
les 87 recettes nouvelles de la liste complémentaire du foyer (`seed_complements_a.py`, `seed_complements_b.py` : bowls,
burritos, cannellonis, nems, parmentiers, poêlées, risottos, salades composées, tajines…) et 66 recettes pour arriver à
300 (`seed_300_a.py`, `seed_300_b.py` : coq au vin, carbonade, choucroute, cassoulet, fondue, moules marinières,
waterzoï, pad thaï sans piment, poké bowl, gaspacho, soupes, plats de printemps…). Les recettes de la liste du foyer
trop proches d'une recette existante (même plat, autre accompagnement) n'ont pas été ajoutées. Réparties pour que les
règles de variété aient de quoi alterner les protéines :

| Protéine principale | Recettes | | Saison | Recettes |
|---|---|---|---|---|
| Volaille | 67 | | Printemps | 204 |
| Bœuf et veau | 35 | | Été | 198 |
| Porc et charcuterie | 46 | | Automne | 248 |
| Poisson | 43 | | Hiver | 219 |
| Fruits de mer | 9 | | Déjeuner possible | 95 |
| Œufs | 17 | | 30 min ou moins | 81 |
| Légumineuses | 25 | | Sans viande ni poisson | 100 |
| Végétarien (fromage, légumes) | 55 | | | |

Les recettes ont été rédigées pour ce projet à partir des produits que le foyer achète réellement (poulet, saumon et truite,
courgettes, butternut, feta, chèvre, wraps, gnocchis, lentilles, cordons bleus, raclette…), pour 4 portions. Le veau est
classé avec le bœuf (viande de boucherie) pour l'équilibre de la semaine, mais s'affiche « Veau ». À mesure que les avis
s'accumulent, la base s'enrichit de recettes importées ou générées par Mistral, validées avant enregistrement.

## Modèle

- `recipes` : identité d'une recette (commune si `household_id` est nul, sinon propre au foyer), source, recette d'origine
  pour une variante, version courante.
- `recipe_versions` : contenu complet (nom, portions, temps actif / cuisson / repos, difficulté, types de repas, protéine,
  saisons, étiquettes, étapes). **Toute modification crée une nouvelle version** ; une recette commune s'adapte en créant
  une variante dans le foyer. Les allergènes sont **recalculés par la base** à partir du référentiel d'ingrédients.
- `recipe_ingredients` : ingrédients reliés au référentiel (même référentiel que les achats), quantité dans l'unité de la
  recette et, quand la conversion est fiable, dans l'unité de référence (g, ml, pièce) pour la comparer aux achats ;
  mode d'adaptation aux portions (`linear`, `sublinear` pour les épices, `fixed`).
- `recipe_ratings` : avis j'aime / neutre / je n'aime pas, par personne et par version.
- `recipe_catalog` (vue) et `recipe_candidates(...)` (fonction) : catalogue filtrable et propositions d'après les achats
  des N derniers jours, avec les ingrédients manquants ; les allergènes exclus sont une contrainte stricte.

Allergènes : liste UE, marquage prudent par ingrédient (`services/catalog/referential.py`), indicatif : la composition
exacte se lit sur l'emballage.

## Préférences du foyer et épices

- `household_preferences` : composition (2 adultes, 1 ado, 1 enfant), allergènes exclus (aucun), groupes exclus (abats,
  coquillages ; les crevettes restent permises), niveau d'épice, 1 à 2 dîners sans viande par semaine, courses hebdomadaires.
- Niveau d'épice des ingrédients (`ingredients.spiciness`, `SPICINESS` dans le référentiel) : 1 = épicé mais doux (curry,
  chorizo), 2 = piquant (piment). Celui d'une recette est le plus élevé de ses ingrédients **obligatoires** (`recipe_catalog.spiciness`).
- Le foyer accepte les plats type curry et le chorizo doux, rien de piquant (`spice_level = 'doux'`). Huit recettes communes
  ont une version 2 « Version douce : rien de piquant » : piment facultatif « dans l'assiette des adultes » (chili con carne,
  poulet basquaise avec paprika doux), curry doux, chorizo doux. Le jeu initial ne contient plus aucun plat piquant.
- `recipe_candidates` applique d'elle-même les allergènes et le niveau d'épice du foyer, en plus des paramètres reçus.

## Module de l'application

```ts
import { listRecipes, getRecipe, scaleIngredients, getRecipeCandidates, adaptRecipe, rateRecipe, currentSeason, getHouseholdPreferences } from "./modules/recipes";

const propositions = await getRecipeCandidates(supabase, householdId, { season: currentSeason(), maxTotalMin: 40, excludedAllergens: ["fruits_a_coque"] });
const recette = await getRecipe(supabase, propositions[0].recipeId);
const pourSix = scaleIngredients(recette.ingredients, recette.servings, 6);
await rateRecipe(supabase, householdId, recette, "like");
```

## Vérifications faites (2026-10-29)

- 84 recettes valides (contrôles Python et TypeScript identiques), tous les ingrédients présents dans le référentiel.
- Allergènes recalculés par la base identiques à ceux calculés en Python pour les 84 recettes.
- Classement des 1 422 produits identique entre Python et la base après l'ajout du pain, des herbes et des épices.
- `recipe_candidates` testé sur les achats réels des 7 derniers jours : 3 recettes réalisables sans achat, puis celles
  auxquelles il manque un ingrédient (nommé).
- Tests : 41 en Python, 44 en TypeScript (dont 10 sur les recettes).

## Limites

- La disponibilité est estimée d'après les achats récents, pas encore d'après un stock (phase « stocks »).
- Les quantités en cuillères ne sont converties que pour les liquides (1 c. à soupe = 15 ml) ; pas de densité supposée.
- Pas encore d'informations nutritionnelles (table Ciqual prévue).
