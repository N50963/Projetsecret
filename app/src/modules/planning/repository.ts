/**
 * Accès Supabase de la planification : chargement des données du moteur (recettes, achats, préférences, historique),
 * enregistrement des repas demandés, des propositions montrées, des refus et des choix.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getHouseholdPreferences } from "../recipes/preferences";
import type { MealType } from "../recipes/types";
import { addDays, PURCHASE_WINDOW_DAYS, purchaseQuantity } from "./stock";
import type {
  IsoDate, MealSlot, MissingIngredient, PlannerContext, PlannerIngredient, PlannerRecipe, Proposal, Purchase, ServedMeal,
} from "./types";

type Row = Record<string, any>;
const PAGE = 1000;

function check(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what} : ${error.message}`);
}

/** Lit toutes les lignes d'une requête, par pages (PostgREST plafonne chaque réponse). */
async function fetchAll(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, what: string) {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    check(error, what);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * Ingrédients des versions de recettes, gardés en mémoire pendant la session : une version ne change jamais (modifier une
 * recette en crée une nouvelle). Seules les versions encore inconnues sont lues, par paquets envoyés ensemble : la
 * recherche de menu par ingrédient de l'accueil les charge, et les propositions s'ouvrent ensuite sans les relire.
 */
const versionIngredients = new Map<string, Row[]>();
let ingredientsLoading: Promise<unknown> = Promise.resolve();
const VERSIONS_PER_REQUEST = 60;

async function ingredientsOfVersions(supabase: SupabaseClient, versionIds: string[]): Promise<Map<string, Row[]>> {
  // Lectures l'une après l'autre : deux écrans qui demandent les mêmes versions ne les lisent pas deux fois.
  const run = ingredientsLoading.then(async () => {
    const missing = [...new Set(versionIds)].filter((v) => !versionIngredients.has(v));
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += VERSIONS_PER_REQUEST) chunks.push(missing.slice(i, i + VERSIONS_PER_REQUEST));
    const pages = await Promise.all(chunks.map((ids) => fetchAll((a, b) => supabase.from("recipe_ingredients")
      .select("version_id, position, label, quantity, unit, base_quantity, base_unit, optional, scale_mode, ingredients(slug, name, category, is_pantry_staple)")
      .in("version_id", ids).order("version_id").order("position").range(a, b), "Ingrédients des recettes illisibles")));
    const found = new Map<string, Row[]>(missing.map((v) => [v, []]));
    for (const rows of pages) for (const r of rows) found.get(r.version_id)?.push(r);
    for (const [v, rows] of found) versionIngredients.set(v, rows);
  });
  ingredientsLoading = run.catch(() => undefined);
  await run;
  return versionIngredients;
}

export async function loadRecipesForPlanning(supabase: SupabaseClient, householdId: string): Promise<PlannerRecipe[]> {
  const [all, ratings, weatherLevels, hidden] = await Promise.all([
    fetchAll((a, b) => supabase.from("recipe_catalog")
      .select("id, version_id, name, total_min, servings, main_protein, meal_types, seasons, cuisine, tags, allergens, spiciness")
      .order("id").range(a, b), "Recettes illisibles"),
    fetchAll((a, b) => supabase.from("recipe_ratings").select("recipe_id, rating").eq("household_id", householdId).range(a, b), "Avis illisibles"),
    // Classement par temps choisi par le foyer (sans lui, la météo s'appuie sur le nom du plat).
    fetchAll((a, b) => supabase.from("recipe_weather").select("recipe_id, level").eq("household_id", householdId).order("recipe_id").range(a, b), "Classement météo illisible")
      .catch(() => []),
    // Recettes supprimées par le foyer : jamais proposées.
    fetchAll((a, b) => supabase.from("hidden_recipes").select("recipe_id").eq("household_id", householdId).order("recipe_id").range(a, b), "Recettes supprimées illisibles")
      .catch(() => []),
  ]);
  const skip = new Set(hidden.map((h) => h.recipe_id as string));
  const catalog = all.filter((r) => !skip.has(r.id));
  const levelOf = new Map(weatherLevels.map((w) => [w.recipe_id, w.level]));
  const known = await ingredientsOfVersions(supabase, catalog.map((r) => r.version_id));
  const ingredients = catalog.flatMap((r) => known.get(r.version_id) ?? []);

  const byVersion = new Map<string, PlannerIngredient[]>();
  for (const i of ingredients) {
    const list = byVersion.get(i.version_id) ?? [];
    list.push({
      slug: i.ingredients?.slug ?? null, label: i.label, category: i.ingredients?.category ?? null, pantry: i.ingredients?.is_pantry_staple ?? false,
      quantity: i.quantity === null ? null : Number(i.quantity), unit: i.unit,
      baseQuantity: i.base_quantity === null ? null : Number(i.base_quantity), baseUnit: i.base_unit, optional: i.optional, scale: i.scale_mode,
    });
    byVersion.set(i.version_id, list);
  }
  // Notes du foyer (étoiles : 4-5 aimé, 1-2 pas aimé) : elles pondèrent toujours les propositions. Comptées en un passage.
  const tally = new Map<string, number>();
  for (const x of ratings) tally.set(`${x.recipe_id}:${x.rating}`, (tally.get(`${x.recipe_id}:${x.rating}`) ?? 0) + 1);
  const votes = (id: string, rating: string) => tally.get(`${id}:${rating}`) ?? 0;
  return catalog.map((r) => ({
    id: r.id, versionId: r.version_id, name: r.name, totalMin: r.total_min, servings: r.servings, mainProtein: r.main_protein,
    mealTypes: r.meal_types, seasons: r.seasons, cuisine: r.cuisine, tags: r.tags, allergens: r.allergens, spiciness: r.spiciness,
    likes: votes(r.id, "like"), dislikes: votes(r.id, "dislike"), ingredients: byVersion.get(r.version_id) ?? [],
    weatherLevel: levelOf.get(r.id) ?? null,
  }));
}

export async function loadPurchases(supabase: SupabaseClient, householdId: string, since: IsoDate): Promise<Purchase[]> {
  const rows = await fetchAll((a, b) => supabase.from("purchased_ingredients")
    .select("receipt_item_id, ingredient_slug, category, quantity, unit, quantity_source, purchased_at")
    .eq("household_id", householdId).gte("purchased_at", since).order("receipt_item_id").range(a, b), "Achats illisibles");
  return rows.map((p) => ({
    slug: p.ingredient_slug, category: p.category, unit: p.unit,
    quantity: purchaseQuantity(p.ingredient_slug, p.unit, p.quantity === null ? null : Number(p.quantity), p.quantity_source ?? null),
    purchasedAt: String(p.purchased_at).slice(0, 10),
  }));
}

/** Données du moteur pour une planification commençant à `start` (repas servis les 21 jours précédents, achats des 30 jours). */
export async function loadPlannerContext(supabase: SupabaseClient, householdId: string, start: IsoDate, planId?: string): Promise<PlannerContext> {
  // Tout est lu en même temps (une seule attente réseau au lieu de cinq à la suite).
  const [recipes, purchases, prefs, meals, proposals] = await Promise.all([
    loadRecipesForPlanning(supabase, householdId),
    loadPurchases(supabase, householdId, addDays(start, -PURCHASE_WINDOW_DAYS)),
    getHouseholdPreferences(supabase, householdId),
    fetchAll((a, b) => supabase.from("meal_slots").select("id, plan_id, recipe_id, meal_date, meal_type, servings")
      .eq("household_id", householdId).eq("status", "accepted").gte("meal_date", addDays(start, -21)).order("id").range(a, b), "Repas passés illisibles"),
    fetchAll((a, b) => supabase.from("meal_proposals").select("slot_id, recipe_id, decision")
      .eq("household_id", householdId).eq("decision", "rejected").order("slot_id").range(a, b), "Refus illisibles"),
  ]);
  const toMeal = (m: Row): ServedMeal => ({ recipeId: m.recipe_id, date: m.meal_date, servings: m.servings, slotId: m.id, mealType: m.meal_type });
  const inPlan = (m: Row) => planId !== undefined && m.plan_id === planId;

  const rejected: Record<string, string[]> = {};
  const rejectionCounts: Record<string, number> = {};
  for (const p of proposals) {
    (rejected[p.slot_id] ??= []).push(p.recipe_id);
    rejectionCounts[p.recipe_id] = (rejectionCounts[p.recipe_id] ?? 0) + 1;
  }
  return {
    recipes, purchases, prefs, rejected, rejectionCounts,
    history: meals.filter((m) => !inPlan(m) && m.meal_date < start).map(toMeal),
    // Menus choisis de la planification, et tous ceux déjà prévus à partir de son début (menu du jour, autre planification) :
    // ils réservent leurs ingrédients et comptent pour l'équilibre.
    accepted: meals.filter((m) => inPlan(m) || m.meal_date >= start).map(toMeal),
  };
}

export interface SlotRequest {
  date: IsoDate;
  mealType: MealType;
  maxTotalMin: number | null;
  servings: number;
}

export interface PlannedSlot extends MealSlot {
  planId: string;
  status: "open" | "accepted" | "skipped";
  recipeId: string | null;
}

const toSlot = (s: Row): PlannedSlot => ({
  id: s.id, planId: s.plan_id, date: s.meal_date, mealType: s.meal_type, maxTotalMin: s.max_total_min, servings: s.servings,
  status: s.status, recipeId: s.recipe_id,
});

/** Crée (ou reprend) la planification et enregistre les repas demandés ; les repas retirés de la sélection sont supprimés. */
export async function savePlan(supabase: SupabaseClient, householdId: string, start: IsoDate, end: IsoDate, requests: SlotRequest[]) {
  const { data: plan, error } = await supabase.from("meal_plans")
    .upsert({ household_id: householdId, start_date: start, end_date: end }, { onConflict: "household_id,start_date" }).select("id").single();
  check(error, "Planification non enregistrée");
  const planId = (plan as Row).id as string;
  // Repas déjà enregistrés de la semaine lus pendant l'enregistrement des repas demandés (une attente de moins) : ceux
  // qui ne sont plus demandés et pas encore choisis sont retirés, y compris ceux d'une planification plus ancienne (un
  // dîner resté « à proposer » d'une planification de la veille revenait sinon dans le calendrier).
  const [{ data: slots, error: e2 }, { data: existing, error: e3 }] = await Promise.all([
    supabase.from("meal_slots").upsert(requests.map((r) => ({
      plan_id: planId, household_id: householdId, meal_date: r.date, meal_type: r.mealType, max_total_min: r.maxTotalMin, servings: r.servings,
    })), { onConflict: "household_id,meal_date,meal_type" }).select("*"),
    supabase.from("meal_slots").select("id, status, plan_id").eq("household_id", householdId).gte("meal_date", start).lte("meal_date", end),
  ]);
  check(e2, "Repas non enregistrés");
  check(e3, "Repas illisibles");
  const keep = new Set(((slots ?? []) as Row[]).map((s) => s.id));
  // Un repas passé auparavant puis de nouveau demandé redevient à pourvoir.
  const reopened = ((slots ?? []) as Row[]).filter((s) => s.status === "skipped").map((s) => s.id);
  if (reopened.length) {
    const { error: e5 } = await supabase.from("meal_slots").update({ status: "open" }).in("id", reopened);
    check(e5, "Repas non rouverts");
    for (const s of (slots ?? []) as Row[]) if (reopened.includes(s.id)) s.status = "open";
  }
  const stale = ((existing ?? []) as Row[]).filter((s) => !keep.has(s.id) && s.status !== "accepted");
  // Repas de cette planification : effacés. Repas d'une planification plus ancienne : passés (articles déjà achetés et
  // historique des propositions gardés).
  const drop = stale.filter((s) => s.plan_id === planId).map((s) => s.id);
  const pass = stale.filter((s) => s.plan_id !== planId && s.status === "open").map((s) => s.id);
  if (drop.length) {
    const { error: e4 } = await supabase.from("meal_slots").delete().in("id", drop);
    check(e4, "Repas non retirés");
  }
  if (pass.length) {
    const { error: e6 } = await supabase.from("meal_slots").update({ status: "skipped" }).in("id", pass);
    check(e6, "Repas non retirés");
  }
  return { planId, slots: ((slots ?? []) as Row[]).map(toSlot) };
}

/**
 * Repas coché ou décoché dans le calendrier de l'accueil, enregistré tout de suite : le choix est gardé au retour sur
 * l'accueil, au redémarrage et sur les autres téléphones du foyer. Coché : repas « à proposer » (créé, ou rouvert, avec
 * son temps disponible). Décoché : repas passé plutôt qu'effacé (articles déjà achetés et historique des propositions
 * gardés). Un menu déjà choisi n'est jamais touché.
 */
export async function setMealWanted(supabase: SupabaseClient, householdId: string, request: SlotRequest, wanted: boolean): Promise<void> {
  if (wanted) {
    await ensureSlot(supabase, householdId, request);
    return;
  }
  const { error } = await supabase.from("meal_slots").update({ status: "skipped" }).eq("household_id", householdId)
    .eq("meal_date", request.date).eq("meal_type", request.mealType).neq("status", "accepted");
  check(error, "Repas non retiré");
}

/**
 * Repas d'un jour pour le menu du jour : repris s'il existe (rouvert s'il avait été passé), sinon créé dans la
 * planification qui couvre ce jour, ou dans une planification d'un jour.
 */
export async function ensureSlot(supabase: SupabaseClient, householdId: string, request: SlotRequest): Promise<PlannedSlot> {
  const { data: existing, error } = await supabase.from("meal_slots").select("*").eq("household_id", householdId)
    .eq("meal_date", request.date).eq("meal_type", request.mealType).maybeSingle();
  check(error, "Repas illisible");
  if (existing) {
    const row = existing as Row;
    const patch: Row = { max_total_min: request.maxTotalMin };
    if (row.status === "skipped") patch.status = "open";
    const { data, error: e2 } = await supabase.from("meal_slots").update(patch).eq("id", row.id).select("*").single();
    check(e2, "Repas non mis à jour");
    return toSlot(data as Row);
  }
  const { data: plans, error: e3 } = await supabase.from("meal_plans").select("id").eq("household_id", householdId)
    .lte("start_date", request.date).gte("end_date", request.date).order("start_date", { ascending: false }).limit(1);
  check(e3, "Planification illisible");
  let planId = ((plans ?? []) as Row[])[0]?.id as string | undefined;
  if (!planId) {
    const { data: plan, error: e4 } = await supabase.from("meal_plans")
      .upsert({ household_id: householdId, start_date: request.date, end_date: request.date }, { onConflict: "household_id,start_date" })
      .select("id").single();
    check(e4, "Planification non enregistrée");
    planId = (plan as Row).id as string;
  }
  const { data: slot, error: e5 } = await supabase.from("meal_slots").insert({
    plan_id: planId, household_id: householdId, meal_date: request.date, meal_type: request.mealType,
    max_total_min: request.maxTotalMin, servings: request.servings,
  }).select("*").single();
  check(e5, "Repas non enregistré");
  return toSlot(slot as Row);
}

/** Articles ajoutés à la liste de courses pour un repas (ingrédients qui manqueront). */
export async function addShoppingItems(supabase: SupabaseClient, householdId: string, slotId: string, items: MissingIngredient[]) {
  if (!items.length) return;
  const { data: ids, error } = await supabase.from("ingredients").select("id, slug").in("slug", items.map((i) => i.slug));
  check(error, "Ingrédients illisibles");
  const idOf = new Map(((ids ?? []) as Row[]).map((r) => [r.slug, r.id as string]));
  const { error: e2 } = await supabase.from("shopping_list_items").insert(items.map((i) => ({
    household_id: householdId, slot_id: slotId, ingredient_id: idOf.get(i.slug) ?? null, label: i.label.slice(0, 200),
    quantity: i.quantity && i.quantity > 0 ? i.quantity : null, unit: i.quantity && i.quantity > 0 ? i.unit : null,
  })));
  check(e2, "Articles non ajoutés à la liste de courses");
}

/** Ingrédient du référentiel utilisé par au moins une recette (choix du menu du jour). */
export interface RecipeIngredientOption {
  slug: string;
  name: string;
  category: string;
  /** Nombre de recettes qui l'utilisent. */
  recipes: number;
}

let recipeIngredients: Promise<RecipeIngredientOption[]> | null = null;

/** Ingrédients des recettes (hors produits de base toujours présents), du plus utilisé au moins utilisé. */
export function ingredientsInRecipes(supabase: SupabaseClient): Promise<RecipeIngredientOption[]> {
  recipeIngredients ??= (async () => {
    const catalog = await fetchAll((a, b) => supabase.from("recipe_catalog").select("version_id").order("version_id").range(a, b), "Recettes illisibles");
    const known = await ingredientsOfVersions(supabase, catalog.map((r) => r.version_id));
    const rows = catalog.flatMap((r) => known.get(r.version_id) ?? []).filter((r) => !r.optional);
    const bySlug = new Map<string, RecipeIngredientOption & { versions: Set<string> }>();
    for (const r of rows) {
      const i = r.ingredients;
      if (!i?.slug || i.is_pantry_staple) continue;
      const entry = bySlug.get(i.slug) ?? { slug: i.slug, name: i.name, category: i.category, recipes: 0, versions: new Set<string>() };
      entry.versions.add(r.version_id);
      entry.recipes = entry.versions.size;
      bySlug.set(i.slug, entry);
    }
    return [...bySlug.values()].map(({ versions: _v, ...o }) => o).sort((a, b) => b.recipes - a.recipes || a.name.localeCompare(b.name));
  })().catch((e) => {
    recipeIngredients = null;
    throw e;
  });
  return recipeIngredients;
}

/** Repas enregistrés à partir d'une date, toutes planifications confondues (menu du jour et repas à remplacer). */
export async function getSlotsFrom(supabase: SupabaseClient, householdId: string, from: IsoDate): Promise<PlannedSlot[]> {
  const { data, error } = await supabase.from("meal_slots").select("*").eq("household_id", householdId).gte("meal_date", from).order("meal_date");
  check(error, "Repas illisibles");
  return ((data ?? []) as Row[]).map(toSlot);
}

export async function getPlanSlots(supabase: SupabaseClient, planId: string): Promise<PlannedSlot[]> {
  const { data, error } = await supabase.from("meal_slots").select("*").eq("plan_id", planId).order("meal_date");
  check(error, "Repas illisibles");
  return ((data ?? []) as Row[]).map(toSlot);
}

/** Garde la trace des propositions montrées pour un repas. */
export async function recordShown(supabase: SupabaseClient, householdId: string, slotId: string, proposals: Proposal[]) {
  if (!proposals.length) return;
  const { error } = await supabase.from("meal_proposals").upsert(proposals.map((p, rank) => ({
    slot_id: slotId, household_id: householdId, recipe_id: p.recipeId, round: p.round, rank, score: p.score,
    missing: p.missing.map((m) => m.label),
  })), { onConflict: "slot_id,recipe_id", ignoreDuplicates: true });
  check(error, "Propositions non enregistrées");
}

/** Swipe à gauche. */
export async function rejectProposal(supabase: SupabaseClient, householdId: string, slotId: string, p: Proposal) {
  const { error } = await supabase.from("meal_proposals").upsert({
    slot_id: slotId, household_id: householdId, recipe_id: p.recipeId, round: p.round, rank: 0, score: p.score,
    missing: p.missing.map((m) => m.label), decision: "rejected", decided_at: new Date().toISOString(),
  }, { onConflict: "slot_id,recipe_id" });
  check(error, "Refus non enregistré");
}

/** Swipe à droite : le repas reçoit la recette, les ingrédients manquants vont sur la liste de courses. */
export async function acceptProposal(supabase: SupabaseClient, slotId: string, p: Pick<Proposal, "recipeId" | "missing">) {
  const { error } = await supabase.rpc("accept_meal_proposal", {
    p_slot_id: slotId, p_recipe_id: p.recipeId,
    p_missing: p.missing.map((m) => ({ slug: m.slug, label: m.label, quantity: m.quantity, unit: m.unit })),
  });
  check(error, "Choix non enregistré");
}

export interface ShoppingItem {
  id: string;
  label: string;
  quantity: number | null;
  unit: string | null;
  createdAt: string;
  checkedAt: string | null;
  boughtAt: string | null;
  /** Plat pour lequel l'article a été mis sur la liste (photo et nom dans la liste de courses). */
  recipeId: string | null;
  recipeName: string | null;
  /** L'article sert un menu choisi à venir (ou une recette ajoutée depuis sa fiche) : seul cas où il est « à acheter ». */
  active: boolean;
  /** Retiré de la liste par le foyer (la fiche recette le signale et propose de le remettre). */
  removedAt: string | null;
}

/**
 * Liste de courses comparée aux derniers tickets (articles achetés depuis leur ajout). Un article n'est « à acheter » que
 * s'il est `active` : son menu est choisi et pas encore passé, ou il a été ajouté depuis la fiche d'une recette.
 */
export async function getShoppingList(supabase: SupabaseClient, householdId: string, sinceDays = 21): Promise<ShoppingItem[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data, error } = await supabase.from("shopping_list_status").select("*").eq("household_id", householdId)
    .gte("created_at", since).order("created_at", { ascending: false });
  check(error, "Liste de courses illisible");
  const rows = (data ?? []) as Row[];
  const slotIds = [...new Set(rows.map((i) => i.slot_id).filter(Boolean))];
  const { data: slots } = slotIds.length ? await supabase.from("meal_slots").select("id, recipe_id").in("id", slotIds) : { data: [] };
  const recipeOfSlot = new Map(((slots ?? []) as Row[]).map((r) => [r.id, r.recipe_id as string | null]));
  const recipeIds = [...new Set([...recipeOfSlot.values(), ...rows.map((i) => i.recipe_id as string | null)].filter((v): v is string => Boolean(v)))];
  const { data: names } = recipeIds.length ? await supabase.from("recipe_catalog").select("id, name").in("id", recipeIds) : { data: [] };
  const nameOf = new Map(((names ?? []) as Row[]).map((n) => [n.id, n.name as string]));
  return rows.map((i) => {
    const recipeId: string | null = (i.slot_id ? recipeOfSlot.get(i.slot_id) : undefined) ?? i.recipe_id ?? null;
    return {
      id: i.id, label: i.label, quantity: i.quantity === null ? null : Number(i.quantity), unit: i.unit, createdAt: i.created_at,
      checkedAt: i.checked_at, boughtAt: i.bought_at, recipeId, recipeName: recipeId ? nameOf.get(recipeId) ?? null : null,
      active: i.active ?? true, removedAt: i.removed_at ?? null,
    };
  });
}

/** Retire des articles de la liste (ou les y remet) : ils ne sont pas effacés, la fiche recette garde la trace du retrait. */
export async function setShoppingItemsRemoved(supabase: SupabaseClient, itemIds: string[], removed: boolean) {
  if (!itemIds.length) return;
  const { error } = await supabase.from("shopping_list_items").update({ removed_at: removed ? new Date().toISOString() : null }).in("id", itemIds);
  check(error, removed ? "Article non retiré" : "Article non remis sur la liste");
}

export async function setShoppingItemChecked(supabase: SupabaseClient, itemId: string, checked: boolean) {
  const { error } = await supabase.from("shopping_list_items").update({ checked_at: checked ? new Date().toISOString() : null }).eq("id", itemId);
  check(error, "Article non mis à jour");
}

/** Repas pour lequel aucun menu n'est retenu (« passer »). */
export async function skipSlot(supabase: SupabaseClient, slotId: string) {
  const { error } = await supabase.from("meal_slots").update({ status: "skipped" }).eq("id", slotId);
  check(error, "Repas non mis à jour");
}

export interface UpcomingMeal {
  slotId: string;
  date: IsoDate;
  mealType: MealType;
  recipeId: string;
  name: string;
}

export interface WeekSlot {
  slotId: string;
  date: IsoDate;
  mealType: MealType;
  status: "open" | "accepted" | "skipped";
  maxTotalMin: number | null;
  recipeId: string | null;
  name: string | null;
  /** Temps total de la recette choisie (minutes) et difficulté (1 à 3). */
  totalMin: number | null;
  difficulty: number | null;
}

/** Repas enregistrés entre deux dates, avec le nom de la recette choisie (calendrier de l'accueil). */
export async function getWeekSlots(supabase: SupabaseClient, householdId: string, from: IsoDate, to: IsoDate): Promise<WeekSlot[]> {
  const { data, error } = await supabase.from("meal_slots").select("id, meal_date, meal_type, status, max_total_min, recipe_id")
    .eq("household_id", householdId).gte("meal_date", from).lte("meal_date", to);
  check(error, "Repas illisibles");
  const rows = (data ?? []) as Row[];
  const ids = [...new Set(rows.map((r) => r.recipe_id).filter(Boolean))];
  const { data: names, error: e2 } = ids.length
    ? await supabase.from("recipe_catalog").select("id, name, total_min, difficulty").in("id", ids) : { data: [], error: null };
  check(e2, "Recettes illisibles");
  const recipeOf = new Map(((names ?? []) as Row[]).map((n) => [n.id, n]));
  return rows.map((r) => {
    const recipe = r.recipe_id ? recipeOf.get(r.recipe_id) : undefined;
    return {
      slotId: r.id, date: r.meal_date, mealType: r.meal_type, status: r.status, maxTotalMin: r.max_total_min, recipeId: r.recipe_id,
      name: r.recipe_id ? recipe?.name ?? "Recette" : null, totalMin: recipe?.total_min ?? null, difficulty: recipe?.difficulty ?? null,
    };
  });
}

/** Annule le menu choisi : le repas redevient à prévoir et ses articles non cochés quittent la liste de courses. */
export async function cancelMealChoice(supabase: SupabaseClient, slotId: string) {
  const { error } = await supabase.rpc("cancel_meal_choice", { p_slot_id: slotId });
  check(error, "Choix non annulé");
}

/**
 * Déplace un menu choisi vers un autre jour ou un autre repas ; si un repas y est déjà prévu, les deux menus s'échangent
 * (chaque repas garde son temps disponible et son nombre de personnes ; les articles de courses suivent leur menu).
 */
export async function moveMealChoice(supabase: SupabaseClient, slotId: string, date: IsoDate, mealType: MealType) {
  const { error } = await supabase.rpc("move_meal_choice", { p_slot_id: slotId, p_date: date, p_meal_type: mealType });
  check(error, "Menu non déplacé");
}

/** Repas choisis à partir d'une date (accueil). */
export async function getUpcomingMeals(supabase: SupabaseClient, householdId: string, from: IsoDate, limit = 7): Promise<UpcomingMeal[]> {
  const { data, error } = await supabase.from("meal_slots").select("id, meal_date, meal_type, recipe_id").eq("household_id", householdId)
    .eq("status", "accepted").gte("meal_date", from).order("meal_date").order("meal_type", { ascending: false }).limit(limit);
  check(error, "Menus illisibles");
  const rows = (data ?? []) as Row[];
  const ids = [...new Set(rows.map((r) => r.recipe_id))];
  const { data: names, error: e2 } = ids.length ? await supabase.from("recipe_catalog").select("id, name").in("id", ids) : { data: [], error: null };
  check(e2, "Recettes illisibles");
  const nameOf = new Map(((names ?? []) as Row[]).map((n) => [n.id, n.name]));
  return rows.map((r) => ({ slotId: r.id, date: r.meal_date, mealType: r.meal_type, recipeId: r.recipe_id, name: nameOf.get(r.recipe_id) ?? "Recette" }));
}
