/**
 * Accès à la base de recettes (Supabase). Les écritures passent par des fonctions de la base qui garantissent
 * le versionnement : une modification crée une nouvelle version, l'original n'est jamais écrasé ;
 * une recette commune (jeu initial) s'adapte en créant une variante dans le foyer.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  MainProtein, MealType, Rating, Recipe, RecipeCandidate, RecipeIngredient, RecipeInput, RecipeRating, Season, Spiciness, Stars,
} from "./types";
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
  maxSpiciness?: Spiciness;
  excludedAllergens?: string[];
  search?: string;
  /** Nombre maximal de recettes ; sans limite, tout le catalogue est lu (par pages). */
  limit?: number;
}

/** Taille d'une page : Supabase (PostgREST) renvoie au plus 1 000 lignes par requête. */
const PAGE = 1000;

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
  spiciness: Spiciness;
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
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "recette";
}

function toSummary(r: Row): RecipeSummary {
  return {
    id: r.id, householdId: r.household_id, name: r.name, description: r.description, servings: r.servings, totalMin: r.total_min,
    mainProtein: r.main_protein, mealTypes: r.meal_types, seasons: r.seasons, tags: r.tags, allergens: r.allergens, spiciness: r.spiciness, source: r.source,
  };
}

/** Catalogue (recettes communes + recettes du foyer), filtré. Les allergènes exclus sont une contrainte stricte. */
export async function listRecipes(supabase: SupabaseClient, filters: RecipeFilters = {}): Promise<RecipeSummary[]> {
  const page = (from: number, to: number) => {
    let q = supabase.from("recipe_catalog").select("*");
    if (filters.mealType) q = q.contains("meal_types", [filters.mealType]);
    if (filters.season) q = q.contains("seasons", [filters.season]);
    if (filters.mainProtein) q = q.eq("main_protein", filters.mainProtein);
    if (filters.maxTotalMin !== undefined) q = q.lte("total_min", filters.maxTotalMin);
    if (filters.maxSpiciness !== undefined) q = q.lte("spiciness", filters.maxSpiciness);
    if (filters.excludedAllergens?.length) q = q.not("allergens", "ov", `{${filters.excludedAllergens.join(",")}}`);
    if (filters.search) q = q.ilike("name", `%${filters.search}%`);
    // Le nom seul ne suffit pas à ordonner les pages : deux recettes peuvent porter le même nom.
    return q.order("name").order("id").range(from, to);
  };
  const max = filters.limit ?? Infinity;
  const rows: Row[] = [];
  while (rows.length < max) {
    const size = Math.min(PAGE, max - rows.length);
    const { data, error } = await page(rows.length, rows.length + size - 1);
    check(error, "Lecture des recettes impossible");
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < size) break;
  }
  return rows.map(toSummary);
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
    seasons: row.seasons, tags: row.tags, allergens: row.allergens, spiciness: row.spiciness, source: row.source, parentRecipeId: row.parent_recipe_id,
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
  const { id: _id, versionId: _v, versionNo: _n, totalMin: _t, allergens: _a, spiciness: _s, householdId: owner, ...base } = original;
  const input: RecipeInput = { ...base, ...changes };
  if (owner === householdId) return addRecipeVersion(supabase, original.id, input, changeNote);
  return createRecipe(supabase, householdId, { ...input, slug: `${original.slug ?? slugify(original.name)}-variante`, parentRecipeId: original.id, source: "manual" });
}

export async function archiveRecipe(supabase: SupabaseClient, recipeId: string, archived = true): Promise<void> {
  const { error } = await supabase.rpc("set_recipe_archived", { p_recipe_id: recipeId, p_archived: archived });
  check(error, "Archivage refusé");
}

/** Étoiles ramenées à l'avis utilisé par le planificateur (4-5 : aimé, 3 : bof, 1-2 : pas aimé), comme le fait la base. */
export const starsToRating = (stars: Stars): Rating => (stars >= 4 ? "like" : stars === 3 ? "neutral" : "dislike");

/** Dernière note (étoiles) du foyer pour chaque recette notée. */
export async function latestStars(supabase: SupabaseClient, householdId: string): Promise<Map<string, Stars>> {
  const { data, error } = await supabase.from("recipe_ratings").select("recipe_id, stars, rated_at")
    .eq("household_id", householdId).not("stars", "is", null).order("rated_at", { ascending: false }).limit(1000);
  check(error, "Notes illisibles");
  const out = new Map<string, Stars>();
  for (const r of (data ?? []) as Row[]) if (!out.has(r.recipe_id)) out.set(r.recipe_id, r.stars as Stars);
  return out;
}

/** Dernier avis du foyer sur la recette (null s'il n'y en a pas). */
export async function getLatestRating(supabase: SupabaseClient, householdId: string, recipeId: string): Promise<RecipeRating | null> {
  const { data, error } = await supabase.from("recipe_ratings").select("id, user_id, version_id, stars, rating, comment, rated_at")
    .eq("household_id", householdId).eq("recipe_id", recipeId).order("rated_at", { ascending: false }).limit(1);
  check(error, "Avis illisible");
  const r = (data ?? [])[0] as Row | undefined;
  return r ? { id: r.id, userId: r.user_id, versionId: r.version_id, stars: r.stars, rating: r.rating, comment: r.comment, ratedAt: r.rated_at } : null;
}

/**
 * Avis sur 5 étoiles, avec un commentaire facultatif, rattaché à la version cuisinée. Un nouvel avis sur la même version
 * remplace le précédent du même utilisateur (pas de doublon dans les statistiques du planificateur).
 */
export async function rateRecipe(
  supabase: SupabaseClient, householdId: string, recipe: Pick<Recipe, "id" | "versionId">, stars: Stars, comment?: string | null,
  previous?: RecipeRating | null,
): Promise<void> {
  const fields = { stars, rating: starsToRating(stars), comment: comment?.trim() || null, rated_at: new Date().toISOString() };
  const { data: auth } = await supabase.auth.getUser();
  const replace = previous && previous.versionId === recipe.versionId && previous.userId === auth.user?.id;
  const { error } = replace
    ? await supabase.from("recipe_ratings").update(fields).eq("id", previous.id)
    : await supabase.from("recipe_ratings").insert({ household_id: householdId, recipe_id: recipe.id, version_id: recipe.versionId, ...fields });
  check(error, "Avis non enregistré");
}

/** La recette est-elle dans les favoris du foyer ? */
export async function isFavorite(supabase: SupabaseClient, householdId: string, recipeId: string): Promise<boolean> {
  const { data, error } = await supabase.from("recipe_favorites").select("recipe_id").eq("household_id", householdId).eq("recipe_id", recipeId).limit(1);
  check(error, "Favoris illisibles");
  return (data ?? []).length > 0;
}

export async function setFavorite(supabase: SupabaseClient, householdId: string, recipeId: string, favorite: boolean): Promise<void> {
  const { error } = favorite
    ? await supabase.from("recipe_favorites").upsert({ household_id: householdId, recipe_id: recipeId }, { onConflict: "household_id,recipe_id" })
    : await supabase.from("recipe_favorites").delete().eq("household_id", householdId).eq("recipe_id", recipeId);
  check(error, "Favori non enregistré");
}

export async function listFavorites(supabase: SupabaseClient, householdId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from("recipe_favorites").select("recipe_id").eq("household_id", householdId);
  check(error, "Favoris illisibles");
  return new Set(((data ?? []) as Row[]).map((r) => r.recipe_id as string));
}

/** Ingrédient de la recette à acheter (ni de placard, ni acheté ces 7 derniers jours). */
export interface ShoppingNeed {
  /** null : ingrédient hors référentiel (ajouté à la liste sous son libellé). */
  ingredientId: string | null;
  slug: string;
  label: string;
  quantity: number | null;
  unit: string | null;
  /** Déjà sur la liste de courses. */
  onList: boolean;
}

export async function getShoppingNeeds(supabase: SupabaseClient, householdId: string, recipeId: string, servings: number): Promise<ShoppingNeed[]> {
  const { data, error } = await supabase.rpc("recipe_shopping_needs", { p_household: householdId, p_recipe_id: recipeId, p_servings: servings });
  check(error, "Ingrédients à acheter illisibles");
  return ((data ?? []) as Row[]).map((n) => ({
    ingredientId: n.ingredient_id, slug: n.slug, label: n.label, quantity: n.quantity === null ? null : Number(n.quantity), unit: n.unit, onList: n.on_list,
  }));
}

/** Met sur la liste de courses les ingrédients à acheter ; renvoie le nombre d'articles ajoutés. */
export async function addRecipeToShoppingList(supabase: SupabaseClient, householdId: string, recipeId: string, servings: number): Promise<number> {
  const { data, error } = await supabase.rpc("add_recipe_to_shopping_list", { p_household: householdId, p_recipe_id: recipeId, p_servings: servings });
  check(error, "Liste de courses non complétée");
  return Number(data ?? 0);
}

/** État d'un ingrédient de la recette pour la liste de courses (hors facultatifs et produits de placard). */
export interface IngredientShopping extends ShoppingNeed {
  /** Acheté ces 7 derniers jours (repli quand le stock estimé n'est pas lisible). */
  boughtRecently: boolean;
  /** Retiré de la liste de courses par le foyer (pour cette recette ou son menu à venir), et pas remis. */
  removed: boolean;
  /** Articles retirés, à remettre sur la liste si le foyer le décide. */
  removedItems: string[];
}

export async function getShoppingStatus(supabase: SupabaseClient, householdId: string, recipeId: string, servings: number): Promise<IngredientShopping[]> {
  const { data, error } = await supabase.rpc("recipe_shopping_state", { p_household: householdId, p_recipe_id: recipeId, p_servings: servings });
  check(error, "Ingrédients à acheter illisibles");
  return ((data ?? []) as Row[]).map((n) => ({
    ingredientId: n.ingredient_id, slug: n.slug, label: n.label, quantity: n.quantity === null ? null : Number(n.quantity), unit: n.unit,
    onList: n.on_list, boughtRecently: n.bought_recently, removed: n.removed ?? false, removedItems: n.removed_items ?? [],
  }));
}

/**
 * Met sur la liste de courses les ingrédients choisis d'une recette (ceux que la fiche montre « à acheter », d'après le
 * même stock que les propositions) ; renvoie le nombre d'articles ajoutés.
 */
export async function addNeedsToShoppingList(supabase: SupabaseClient, householdId: string, recipeId: string, needs: ShoppingNeed[]): Promise<number> {
  const rows = needs.filter((n) => !n.onList);
  if (!rows.length) return 0;
  const { error } = await supabase.from("shopping_list_items").insert(rows.map((n) => ({
    household_id: householdId, recipe_id: recipeId, ingredient_id: n.ingredientId, label: n.label.slice(0, 200),
    quantity: n.quantity && n.quantity > 0 ? n.quantity : null, unit: n.quantity && n.quantity > 0 ? n.unit : null,
  })));
  check(error, "Liste de courses non complétée");
  return rows.length;
}

/** Ce qui est déjà sur la liste de courses (à acheter) : ingrédients du référentiel et libellés (pour les autres). */
export interface ListedIngredients {
  ids: Set<string>;
  labels: Set<string>;
}

const foldLabel = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
export const isLabelListed = (listed: ListedIngredients, label: string) => listed.labels.has(foldLabel(label));

export async function getListedIngredients(supabase: SupabaseClient, householdId: string): Promise<ListedIngredients> {
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString();
  const { data, error } = await supabase.from("shopping_list_status").select("ingredient_id, label")
    .eq("household_id", householdId).eq("active", true).is("checked_at", null).is("bought_at", null).gte("created_at", since);
  check(error, "Liste de courses illisible");
  const rows = (data ?? []) as Row[];
  return { ids: new Set(rows.map((r) => r.ingredient_id).filter(Boolean)), labels: new Set(rows.map((r) => foldLabel(String(r.label ?? "")))) };
}

/** Identifiants du référentiel des ingrédients d'une recette (pour mettre sur la liste un produit de placard, du sel…). */
export async function ingredientIds(supabase: SupabaseClient, slugs: string[]): Promise<Map<string, string>> {
  if (!slugs.length) return new Map();
  const { data, error } = await supabase.from("ingredients").select("id, slug").in("slug", [...new Set(slugs)]);
  check(error, "Ingrédients illisibles");
  return new Map(((data ?? []) as Row[]).map((r) => [r.slug as string, r.id as string]));
}

export interface CandidateOptions {
  days?: number;
  maxMissing?: number;
  mealType?: MealType;
  season?: Season | null;
  maxTotalMin?: number | null;
  excludedAllergens?: string[];
}

/**
 * Recettes réalisables avec les achats récents (au plus maxMissing ingrédients à acheter), les plus faciles d'abord.
 * La base applique aussi les préférences du foyer (allergènes exclus, niveau d'épice accepté).
 */
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
