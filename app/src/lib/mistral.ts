/** Appels à la fonction serveur « mistral » (la clé Mistral ne quitte jamais Supabase). */

import { FunctionsHttpError } from "@supabase/supabase-js";

import type { MainProtein, MealType, RecipeInput, RecipeSource, Season } from "../modules/recipes";
import { supabase } from "./supabase";
import { wholeSentences } from "./format";

/** Recette au format de la base (snake_case), telle que renvoyée par la fonction. */
export interface DraftRecipe {
  name: string;
  description: string | null;
  servings: number;
  prep_min: number;
  cook_min: number;
  rest_min: number;
  difficulty: number;
  meal_types: MealType[];
  main_protein: MainProtein;
  cuisine: string | null;
  seasons: Season[];
  tags: string[];
  steps: string[];
  ingredients: Array<{ slug: string | null; label: string; quantity: number | null; unit: any; base_quantity: number | null;
    base_unit: any; optional: boolean; scale: any }>;
}

export interface Draft {
  recipe: DraftRecipe;
  issues: string[];
}

/**
 * Appel de la fonction serveur. `signal` permet d'abandonner une demande devenue inutile : sur Android, l'application
 * n'ouvre que 5 connexions à la fois vers Supabase, et une demande à Mistral (20 à 60 s) en occupe une.
 */
async function call<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const { data, error } = await supabase.functions.invoke("mistral", { body, signal });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const detail = await error.context.json().catch(() => null);
      throw new Error(detail?.error ?? "La réflexion approfondie n'a pas répondu.");
    }
    throw new Error("Réflexion approfondie injoignable : vérifiez la connexion internet.");
  }
  return data as T;
}

export const mistralStatus = (householdId: string) =>
  call<{ key_valid: boolean; text_model?: string; image_model?: string }>({ action: "status", household_id: householdId });

export const importRecipe = (householdId: string, text: string, servings: number) =>
  call<Draft>({ action: "import_recipe", household_id: householdId, text, servings });

/** Recette importée d'une photo, d'une page ou de la voix : le texte lu (ou transcrit) accompagne le brouillon. */
export type ImportedDraft = Draft & { source_text?: string; source_url?: string };

export const importPhoto = (householdId: string, images: string[], servings: number) =>
  call<ImportedDraft>({ action: "import_photo", household_id: householdId, images, servings });

export const importUrl = (householdId: string, url: string, servings: number) =>
  call<ImportedDraft>({ action: "import_url", household_id: householdId, url, servings });

export const importAudio = (householdId: string, audio: string, mime: string, servings: number) =>
  call<ImportedDraft>({ action: "import_audio", household_id: householdId, audio, mime, servings });

export interface GenerateRequest {
  brief: string;
  count?: number;
  servings: number;
  constraints: { max_total_min?: number | null; main_protein?: string; season?: string; meal_type?: MealType; avoid?: string[] };
}

export const generateRecipes = (householdId: string, req: GenerateRequest, signal?: AbortSignal) =>
  call<{ recipes: Draft[] }>({ action: "generate_recipes", household_id: householdId, ...req }, signal);

/** Version améliorée d'après l'avis du foyer, ou `improvable: false` si Mistral ne voit rien à changer. */
export type Adaptation = { improvable: false } | (Draft & { improvable: true; change_note: string });

export const adaptRecipeDraft = async (householdId: string, recipe: unknown, feedback: string): Promise<Adaptation> => {
  const out = await call<Adaptation>({ action: "adapt_recipe", household_id: householdId, recipe, feedback });
  return out.improvable ? { ...out, change_note: wholeSentences(out.change_note ?? "") } : out;
};

export const illustrateRecipe = (householdId: string, recipeId: string, signal?: AbortSignal) =>
  call<{ path: string }>({ action: "illustrate", household_id: householdId, recipe_id: recipeId }, signal);

export function draftToInput(d: DraftRecipe, source: RecipeSource): RecipeInput {
  return {
    name: d.name, description: d.description, servings: d.servings, prepMin: d.prep_min, cookMin: d.cook_min, restMin: d.rest_min,
    difficulty: d.difficulty, mealTypes: d.meal_types, mainProtein: d.main_protein, cuisine: d.cuisine, seasons: d.seasons, tags: d.tags,
    steps: d.steps, source,
    ingredients: d.ingredients.map((i) => ({
      slug: i.slug, label: i.label, quantity: i.quantity, unit: i.unit, baseQuantity: i.base_quantity, baseUnit: i.base_unit,
      optional: i.optional, scale: i.scale,
    })),
  };
}

/** Ce que Mistral comprend de produits de tickets Lidl (nom lisible, rôle, ingrédients du référentiel). */
export interface ProductSuggestion {
  id: string;
  name: string;
  role: "ingredient" | "prepared_meal" | "dessert" | "snack" | "breakfast" | "beverage" | "bread" | "non_food";
  ingredients: string[];
}

export const suggestProducts = (householdId: string, productIds: string[]) =>
  call<{ suggestions: ProductSuggestion[] }>({ action: "suggest_products", household_id: householdId, product_ids: productIds.slice(0, 25) });
