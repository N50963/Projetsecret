/**
 * Adaptation d'une recette au nombre de personnes. Le calcul est explicite et vérifiable :
 * - « linear » : quantité × (portions voulues / portions de référence) ;
 * - « sublinear » (épices, sel, bouillon…) : quantité × ratio^0,7, pour ne pas sur-assaisonner ;
 * - « fixed » : inchangé (ex. une feuille de laurier).
 * Les quantités sont ensuite arrondies à des valeurs utilisables en cuisine. Aucune conversion d'unité n'est faite.
 */

import type { RecipeIngredient, RecipeUnit } from "./types";

export const SUBLINEAR_EXPONENT = 0.7;

export function scaleFactor(mode: RecipeIngredient["scale"], ratio: number): number {
  if (mode === "fixed") return 1;
  if (mode === "sublinear") return Math.pow(ratio, SUBLINEAR_EXPONENT);
  return ratio;
}

/** Arrondi « de cuisine » selon l'unité. */
export function roundForKitchen(value: number, unit: RecipeUnit | null, originalIsWhole: boolean): number {
  if (unit === "g" || unit === "ml") {
    if (value < 20) return Math.max(1, Math.round(value));
    if (value < 100) return Math.round(value / 5) * 5;
    return Math.round(value / 10) * 10;
  }
  if (unit === "piece") {
    return originalIsWhole ? Math.max(1, Math.round(value)) : Math.max(0.5, Math.round(value * 2) / 2);
  }
  if (unit === "cs" || unit === "cc") return Math.max(0.5, Math.round(value * 2) / 2);
  if (unit === "pincee") return Math.max(1, Math.round(value));
  return Math.round(value * 100) / 100;
}

export function scaleIngredient(ingredient: RecipeIngredient, fromServings: number, toServings: number): RecipeIngredient {
  if (fromServings <= 0 || toServings <= 0) throw new Error("Le nombre de portions doit être positif.");
  const factor = scaleFactor(ingredient.scale, toServings / fromServings);
  const scale = (value: number | null, unit: RecipeUnit | null) =>
    value === null ? null : roundForKitchen(value * factor, unit, Number.isInteger(value));
  return {
    ...ingredient,
    quantity: scale(ingredient.quantity, ingredient.unit),
    baseQuantity: scale(ingredient.baseQuantity, ingredient.baseUnit),
  };
}

export function scaleIngredients(ingredients: RecipeIngredient[], fromServings: number, toServings: number): RecipeIngredient[] {
  return ingredients.map((i) => scaleIngredient(i, fromServings, toServings));
}
