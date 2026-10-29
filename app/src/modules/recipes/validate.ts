/**
 * Validation d'une recette avant enregistrement : obligatoire pour une recette importée (texte, URL, photo)
 * ou générée par Mistral, dont la réponse n'est jamais considérée comme correcte d'office.
 * La base applique ses propres contraintes en plus (référentiel d'ingrédients, allergènes recalculés).
 */

import { MAIN_PROTEINS, MEAL_TYPES, RECIPE_UNITS, SCALE_MODES, SEASONS, type RecipeInput } from "./types";

export interface ValidationIssue {
  field: string;
  message: string;
}

const isInt = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function validateRecipe(input: RecipeInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  if (typeof input.name !== "string" || input.name.trim().length < 2 || input.name.length > 120) add("name", "Nom manquant ou trop long (2 à 120 caractères).");
  if (!isInt(input.servings, 1, 20)) add("servings", "Le nombre de portions doit être un entier de 1 à 20.");
  if (!isInt(input.prepMin, 0, 600)) add("prepMin", "Temps de préparation invalide (minutes).");
  if (!isInt(input.cookMin, 0, 1440)) add("cookMin", "Temps de cuisson invalide (minutes).");
  if (input.restMin !== undefined && !isInt(input.restMin, 0, 2880)) add("restMin", "Temps de repos invalide (minutes).");
  if (input.difficulty !== undefined && !isInt(input.difficulty, 1, 3)) add("difficulty", "La difficulté va de 1 à 3.");
  if (!Array.isArray(input.mealTypes) || input.mealTypes.length === 0 || !input.mealTypes.every((m) => MEAL_TYPES.includes(m))) add("mealTypes", "Types de repas invalides.");
  if (!MAIN_PROTEINS.includes(input.mainProtein)) add("mainProtein", "Protéine principale inconnue.");
  if (!Array.isArray(input.seasons) || input.seasons.length === 0 || !input.seasons.every((s) => SEASONS.includes(s))) add("seasons", "Saisons invalides.");
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.some((s) => typeof s !== "string" || !s.trim())) add("steps", "Au moins une étape, sans étape vide.");

  if (!Array.isArray(input.ingredients) || input.ingredients.length === 0) {
    add("ingredients", "Au moins un ingrédient.");
  } else {
    const slugs = new Set<string>();
    input.ingredients.forEach((ing, i) => {
      const f = `ingredients[${i}]`;
      if (!ing.label?.trim() && !ing.slug) add(f, "Ingrédient sans nom.");
      if (ing.quantity !== null && !(typeof ing.quantity === "number" && ing.quantity > 0 && Number.isFinite(ing.quantity))) add(f, "Quantité invalide (positive ou absente).");
      if (ing.unit !== null && !RECIPE_UNITS.includes(ing.unit)) add(f, `Unité inconnue : ${ing.unit}.`);
      if (ing.quantity !== null && ing.unit === null) add(f, "Une quantité doit avoir une unité.");
      if (!SCALE_MODES.includes(ing.scale)) add(f, "Mode d'adaptation inconnu.");
      if (ing.slug) {
        if (!/^[a-z0-9_]+$/.test(ing.slug)) add(f, "Identifiant d'ingrédient mal formé.");
        if (slugs.has(ing.slug)) add(f, `Ingrédient en double : ${ing.slug}.`);
        slugs.add(ing.slug);
      }
    });
  }
  return issues;
}
