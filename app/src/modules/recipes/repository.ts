/**
 * Accès à la base de recettes (Supabase). Les écritures passent par des fonctions de la base qui garantissent
 * le versionnement : une modification crée une nouvelle version, l'original n'est jamais écrasé ;
 * une recette commune (jeu initial) s'adapte en créant une variante dans le foyer.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { MainProtein, MealType, Rating, Recipe, RecipeCandidate, RecipeIngredient, RecipeInput, Season } from "./types";
import { validateRecipe } from "./validate";

export class RecipeValidationError extends Error {
  constructor(readonly issues: Array<{ field: string; message: string }>) {
    super(`Recette invalide : ${issues.map((i) => i.message).join(" ; ")}`);
    this.name = "RecipeValidationError";
  }
}

export interface RecipeFilters {
  mealType?: MealType;
  season?: Season;
  mainProtein?: MainProtein;
  maxTotalMin?: number;
  excludedAllergens?: string[];
  search?: string;
  limit?: number;
}

export interface RecipeSummary {
  id: string;
  householdId: string | null;
  name: string;
  description: string | null;
  servings: number;
  totalMin: number;
  mainProtein: MainProtein;
  mealTypes: MealType[];
  seasons: Season[];
  tags: string[];
  allergens: string[];
  source: Recipe["source"];
}

type Row = Record<string, any>;

function check(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what} : ${error.message}`);
}

/** Corps attendu par les fonctions create_recipe / add_recipe_version. */
export function toPayload(input: RecipeInput) {
  return {
    slug: input.slug ?? slugify(input.name),
    name: input.name.trim(),
    description: input.description ?? null,
    servings: input.servings,
    prep_min: input.prepMin,
    cook_min: input.cookMin,
    rest_min: input.restMin ?? 0,
    difficulty: input.difficulty ?? 1,
    meal_types: input.mealTypes,
    main_protein: input.mainProtein,
    cuisine: input.cuisine ?? null,
    seasons: input.seasons,
    tags: input.tags ?? [],
    steps: input.steps.map((s) => s.trim()),
    source: input.source ?? "manual",
    source_ref: input.sourceRef ?? null,
    parent_recipe_id: input.parentRecipeId ?? null,
    ingredients: input.ingredients.map((i) => ({
      slug: i.slug, label: i.label, quantity: i.quantity, unit: i.unit, base_quantity: i.baseQuantity,
      base_unit: i.baseUnit, optional: i.optional, scale: i.scale,
    })),
  };
}

export function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "recette";
}

function toSummary(r: Row): RecipeSummary {
  return {
    id: r.id, householdId: r.household_id, name: r.name, description: r.description, servings: r.servings, totalMin: r.total_min,
    mainProtein: r.main_protein, mealTypes: r.meal_types, seasons: r.seasons, tags: r.tags, allergens: r.allergens, source: r.source,
  };
}

/** Catalogue (recettes communes + recettes du foyer), filtré. Les allergènes exclus sont une contrainte stricte. */
export async function listRecipes(supabase: SupabaseClient, filters: RecipeFilters = {}): Promise<RecipeSummary[]> {
  let q = supabase.from("recipe_catalog").select("*");
  if (filters.mealType) q = q.contains("meal_types", [filters.mealType]);
  if (filters.season) q = q.contains("seasons", [filters.season]);
  if (filters.mainProtein) q = q.eq("main_protein", filters.mainProtein);
  if (filters.maxTotalMin !== undefined) q = q.lte("total_min", filters.maxTotalMin);
  if (filters.excludedAllergens?.length) q = q.not("allergens", "ov", `{${filters.excludedAllergens.join(",")}}`);
  if (filters.search) q = q.ilike("name", `%${filters.search}%`);
  const { data, error } = await q.order("name").limit(filters.limit ?? 200);
  check(error, "Lecture des recettes impossible");
  return ((data ?? []) as Row[]).map(toSummary);
}

/** Recette complète (version courante), ingrédients dans l'ordre. */
export async function getRecipe(supabase: SupabaseClient, recipeId: string): Promise<Recipe> {
  const { data: r, error } = await supabase.from("recipe_catalog").select("*").eq("id", recipeId).single();
  check(error, "Recette introuvable");
  const row = r as Row;
  const [{ data: version, error: e1 }, { data: ings, error: e2 }] = await Promise.all([
    supabase.from("recipe_versions").select("steps").eq("id", row.version_id).single(),
    supabase.from("recipe_ingredients").select("position, label, quantity, unit, base_quantity, base_unit, optional, scale_mode, ingredients(slug)")
      .eq("version_id", row.version_id).order("position"),
  ]);
  check(e1, "Étapes illisibles");
  check(e2, "Ingrédients illisibles");
  const ingredients: RecipeIngredient[] = ((ings ?? []) as Row[]).map((i) => ({
    slug: i.ingredients?.slug ?? null, label: i.label, quantity: i.quantity === null ? null : Number(i.quantity), unit: i.unit,
    baseQuantity: i.base_quantity === null ? null : Number(i.base_quantity), baseUnit: i.base_unit, optional: i.optional, scale: i.scale_mode,
  }));
  return {
    id: row.id, householdId: row.household_id, versionId: row.version_id, versionNo: row.version_no, slug: row.slug, name: row.name,
    description: row.description, servings: row.servings, prepMin: row.prep_min, cookMin: row.cook_min, restMin: row.rest_min,
    totalMin: row.total_min, difficulty: row.difficulty, mealTypes: row.meal_types, mainProtein: row.main_protein, cuisine: row.cuisine,
    seasons: row.seasons, tags: row.tags, allergens: row.allergens, source: row.source, parentRecipeId: row.parent_recipe_id,
    ingredients, steps: (version as Row).steps,
  };
}

/** Nouvelle recette du foyer (saisie, import, génération, ou variante d'une recette existante via parentRecipeId). */
export async function createRecipe(supabase: SupabaseClient, householdId: string, input: RecipeInput): Promise<string> {
  const issues = validateRecipe(input);
  if (issues.length) throw new RecipeValidationError(issues);
  const { data, error } = await supabase.rpc("create_recipe", { p_household: householdId, p: toPayload(input) });
  check(error, "Enregistrement de la recette refusé");
  return data as string;
}

/** Nouvelle version d'une recette du foyer ; l'ancienne reste consultable. */
export async function addRecipeVersion(supabase: SupabaseClient, recipeId: string, input: RecipeInput, changeNote: string): Promise<string> {
  const issues = validateRecipe(input);
  if (issues.length) throw new RecipeValidationError(issues);
  const { data, error } = await supabase.rpc("add_recipe_version", { p_recipe_id: recipeId, p: toPayload(input), p_change_note: changeNote });
  check(error, "Nouvelle version refusée");
  return data as string;
}

/** Adapter une recette : variante dans le foyer pour une recette commune, nouvelle version pour une recette du foyer. */
export async function adaptRecipe(supabase: SupabaseClient, householdId: string, original: Recipe, changes: Partial<RecipeInput>, changeNote: string): Promise<string> {
  const { id: _id, versionId: _v, versionNo: _n, totalMin: _t, allergens: _a, householdId: owner, ...base } = original;
  const input: RecipeInput = { ...base, ...changes };
  if (owner === householdId) return addRecipeVersion(supabase, original.id, input, changeNote);
  return createRecipe(supabase, householdId, { ...input, slug: `${original.slug ?? slugify(original.name)}-variante`, parentRecipeId: original.id, source: "manual" });
}

export async function archiveRecipe(supabase: SupabaseClient, recipeId: string, archived = true): Promise<void> {
  const { error } = await supabase.rpc("set_recipe_archived", { p_recipe_id: recipeId, p_archived: archived });
  check(error, "Archivage refusé");
}

/** Avis après un repas : j'aime / neutre / je n'aime pas, rattaché à la version cuisinée. */
export async function rateRecipe(supabase: SupabaseClient, householdId: string, recipe: Pick<Recipe, "id" | "versionId">, rating: Rating, comment?: string): Promise<void> {
  const { error } = await supabase.from("recipe_ratings").insert({
    household_id: householdId, recipe_id: recipe.id, version_id: recipe.versionId, rating, comment: comment ?? null,
  });
  check(error, "Avis non enregistré");
}

export interface CandidateOptions {
  days?: number;
  maxMissing?: number;
  mealType?: MealType;
  season?: Season | null;
  maxTotalMin?: number | null;
  excludedAllergens?: string[];
}

/** Recettes réalisables avec les achats récents (au plus maxMissing ingrédients à acheter), les plus faciles d'abord. */
export async function getRecipeCandidates(supabase: SupabaseClient, householdId: string, options: CandidateOptions = {}): Promise<RecipeCandidate[]> {
  const { data, error } = await supabase.rpc("recipe_candidates", {
    p_household: householdId, p_days: options.days ?? 7, p_max_missing: options.maxMissing ?? 2, p_meal_type: options.mealType ?? "diner",
    p_season: options.season ?? null, p_max_total_min: options.maxTotalMin ?? null, p_excluded_allergens: options.excludedAllergens ?? [],
  });
  check(error, "Propositions de recettes indisponibles");
  return ((data ?? []) as Row[]).map((r) => ({
    recipeId: r.recipe_id, name: r.name, totalMin: r.total_min, mainProtein: r.main_protein, requiredCount: r.required_count,
    availableCount: r.available_count, missingCount: r.missing_count, missing: r.missing, unmapped: r.unmapped, likes: r.likes, dislikes: r.dislikes,
  }));
}

/** Saison courante (hémisphère nord) pour filtrer les recettes. */
export function currentSeason(date = new Date()): Season {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return "printemps";
  if (m >= 6 && m <= 8) return "ete";
  if (m >= 9 && m <= 11) return "automne";
  return "hiver";
}
