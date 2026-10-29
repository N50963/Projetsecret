/** Types de la base de recettes (miroir des tables recipes / recipe_versions / recipe_ingredients). */

export type MealType = "diner" | "dejeuner";
export type Season = "printemps" | "ete" | "automne" | "hiver";
export type MainProtein = "volaille" | "boeuf" | "porc" | "poisson" | "fruits_de_mer" | "oeuf" | "legumineuse" | "vegetarien";
export type RecipeUnit = "g" | "ml" | "piece" | "cs" | "cc" | "pincee";
export type BaseUnit = "g" | "ml" | "piece";
export type ScaleMode = "linear" | "sublinear" | "fixed";
export type RecipeSource = "seed" | "manual" | "import_text" | "import_url" | "import_photo" | "mistral";
export type Rating = "like" | "neutral" | "dislike";

export const MEAL_TYPES: readonly MealType[] = ["diner", "dejeuner"];
export const SEASONS: readonly Season[] = ["printemps", "ete", "automne", "hiver"];
export const MAIN_PROTEINS: readonly MainProtein[] = ["volaille", "boeuf", "porc", "poisson", "fruits_de_mer", "oeuf", "legumineuse", "vegetarien"];
export const RECIPE_UNITS: readonly RecipeUnit[] = ["g", "ml", "piece", "cs", "cc", "pincee"];
export const SCALE_MODES: readonly ScaleMode[] = ["linear", "sublinear", "fixed"];

export interface RecipeIngredient {
  /** Ingrédient du référentiel (null : ingrédient libre, non comparable aux achats). */
  slug: string | null;
  label: string;
  quantity: number | null;
  unit: RecipeUnit | null;
  /** Quantité dans l'unité de référence de l'ingrédient (g, ml, pièce), quand la conversion est fiable. */
  baseQuantity: number | null;
  baseUnit: BaseUnit | null;
  optional: boolean;
  scale: ScaleMode;
}

/** Contenu d'une recette, tel qu'il est saisi, importé ou généré (avant enregistrement). */
export interface RecipeInput {
  slug?: string;
  name: string;
  description?: string | null;
  servings: number;
  prepMin: number;
  cookMin: number;
  restMin?: number;
  difficulty?: number;
  mealTypes: MealType[];
  mainProtein: MainProtein;
  cuisine?: string | null;
  seasons: Season[];
  tags?: string[];
  ingredients: RecipeIngredient[];
  steps: string[];
  source?: RecipeSource;
  sourceRef?: string | null;
  parentRecipeId?: string | null;
}

/** Recette enregistrée, avec sa version courante. */
export interface Recipe extends RecipeInput {
  id: string;
  householdId: string | null;
  versionId: string;
  versionNo: number;
  totalMin: number;
  allergens: string[];
  source: RecipeSource;
}

export interface RecipeCandidate {
  recipeId: string;
  name: string;
  totalMin: number;
  mainProtein: MainProtein;
  requiredCount: number;
  availableCount: number;
  missingCount: number;
  missing: string[];
  unmapped: string[];
  likes: number;
  dislikes: number;
}
