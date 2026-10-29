/** Types du moteur de menus : recettes avec leurs ingrédients, achats, repas à pourvoir, propositions. */

import type { MainProtein, MealType, Season, Spiciness } from "../recipes/types";
import type { HouseholdPreferences } from "../recipes/preferences";

/** Date du calendrier au format AAAA-MM-JJ. */
export type IsoDate = string;

export interface PlannerIngredient {
  slug: string | null;
  label: string;
  category: string | null;
  /** Produit de base toujours présent (sel, huile, farine...). */
  pantry: boolean;
  quantity: number | null;
  unit: string | null;
  /** Quantité dans l'unité de référence (g, ml, pièce) pour la comparer aux achats. */
  baseQuantity: number | null;
  baseUnit: string | null;
  optional: boolean;
  scale: "linear" | "sublinear" | "fixed";
}

export interface PlannerRecipe {
  id: string;
  versionId: string;
  name: string;
  totalMin: number;
  servings: number;
  mainProtein: MainProtein;
  mealTypes: MealType[];
  seasons: Season[];
  cuisine: string | null;
  tags: string[];
  allergens: string[];
  spiciness: Spiciness;
  likes: number;
  dislikes: number;
  ingredients: PlannerIngredient[];
}

/** Une ligne d'achat ramenée à un ingrédient du référentiel. */
export interface Purchase {
  slug: string;
  category: string;
  /** Quantité achetée dans l'unité de référence ; null si la contenance est inconnue (présence seulement). */
  quantity: number | null;
  unit: string | null;
  purchasedAt: IsoDate;
}

/** Un repas pour lequel un menu est demandé. */
export interface MealSlot {
  id: string;
  date: IsoDate;
  mealType: MealType;
  /** Temps total disponible (préparation + cuisson), en minutes ; null : pas de limite. */
  maxTotalMin: number | null;
  servings: number;
}

/** Repas déjà servi ou choisi : alimente la variété et consomme les achats. */
export interface ServedMeal {
  recipeId: string;
  date: IsoDate;
  servings: number;
  slotId?: string;
}

export interface MissingIngredient {
  slug: string;
  label: string;
  /** Quantité à acheter dans l'unité de référence, si elle est connue. */
  quantity: number | null;
  unit: string | null;
}

export interface Proposal {
  recipeId: string;
  versionId: string;
  name: string;
  totalMin: number;
  mainProtein: MainProtein;
  /** 1 : réalisable avec les achats ; 2 : 1 à 3 ingrédients à acheter. */
  round: 1 | 2;
  score: number;
  missing: MissingIngredient[];
  /** Ingrédients achetés utilisés par la recette (hors produits de base). */
  usesPurchased: string[];
  /** Raisons lisibles du classement (équilibre, variété, fraîcheur). */
  reasons: string[];
}

/** Objectifs d'équilibre pour 7 repas (repères PNNS), ramenés au nombre de repas planifiés. */
export interface BalanceTargets {
  fishMin: number;
  redMeatMax: number;
  poultryMax: number;
  legumesMin: number;
  /** Jours sans servir deux fois la même recette. */
  repeatDays: number;
}

export interface PlannerContext {
  recipes: PlannerRecipe[];
  purchases: Purchase[];
  prefs: HouseholdPreferences;
  /** Repas servis récemment (avant la planification). */
  history: ServedMeal[];
  /** Repas déjà acceptés dans la planification en cours. */
  accepted: ServedMeal[];
  /** Recettes refusées par repas (swipe à gauche). */
  rejected: Record<string, string[]>;
  /** Nombre de refus passés par recette, toutes planifications confondues. */
  rejectionCounts?: Record<string, number>;
  targets?: Partial<BalanceTargets>;
}
