/**
 * Accès Supabase de la planification : chargement des données du moteur (recettes, achats, préférences, historique),
 * enregistrement des repas demandés, des propositions montrées, des refus et des choix.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getHouseholdPreferences } from "../recipes/preferences";
import type { MealType } from "../recipes/types";
import { addDays, PURCHASE_WINDOW_DAYS } from "./stock";
import type { IsoDate, MealSlot, PlannerContext, PlannerIngredient, PlannerRecipe, Proposal, Purchase, ServedMeal } from "./types";

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

export async function loadRecipesForPlanning(supabase: SupabaseClient, householdId: string): Promise<PlannerRecipe[]> {
  const catalog = await fetchAll((a, b) => supabase.from("recipe_catalog")
    .select("id, version_id, name, total_min, servings, main_protein, meal_types, seasons, cuisine, tags, allergens, spiciness")
    .order("id").range(a, b), "Recettes illisibles");
  const ingredients = await fetchAll((a, b) => supabase.from("recipe_ingredients")
    .select("version_id, position, label, quantity, unit, base_quantity, base_unit, optional, scale_mode, ingredients(slug, category, is_pantry_staple)")
    .in("version_id", catalog.map((r) => r.version_id)).order("version_id").order("position").range(a, b), "Ingrédients des recettes illisibles");
  const ratings = await fetchAll((a, b) => supabase.from("recipe_ratings").select("recipe_id, rating")
    .eq("household_id", householdId).range(a, b), "Avis illisibles");

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
  const votes = (id: string, rating: string) => ratings.filter((x) => x.recipe_id === id && x.rating === rating).length;
  return catalog.map((r) => ({
    id: r.id, versionId: r.version_id, name: r.name, totalMin: r.total_min, servings: r.servings, mainProtein: r.main_protein,
    mealTypes: r.meal_types, seasons: r.seasons, cuisine: r.cuisine, tags: r.tags, allergens: r.allergens, spiciness: r.spiciness,
    likes: votes(r.id, "like"), dislikes: votes(r.id, "dislike"), ingredients: byVersion.get(r.version_id) ?? [],
  }));
}

export async function loadPurchases(supabase: SupabaseClient, householdId: string, since: IsoDate): Promise<Purchase[]> {
  const rows = await fetchAll((a, b) => supabase.from("purchased_ingredients")
    .select("receipt_item_id, ingredient_slug, category, quantity, unit, purchased_at")
    .eq("household_id", householdId).gte("purchased_at", since).order("receipt_item_id").range(a, b), "Achats illisibles");
  return rows.map((p) => ({
    slug: p.ingredient_slug, category: p.category, quantity: p.quantity === null ? null : Number(p.quantity), unit: p.unit,
    purchasedAt: String(p.purchased_at).slice(0, 10),
  }));
}

/** Données du moteur pour une planification commençant à `start` (repas servis les 21 jours précédents, achats des 30 jours). */
export async function loadPlannerContext(supabase: SupabaseClient, householdId: string, start: IsoDate, planId?: string): Promise<PlannerContext> {
  const [recipes, purchases, prefs] = await Promise.all([
    loadRecipesForPlanning(supabase, householdId),
    loadPurchases(supabase, householdId, addDays(start, -PURCHASE_WINDOW_DAYS)),
    getHouseholdPreferences(supabase, householdId),
  ]);
  const { data: served, error } = await supabase.from("meal_slots").select("id, plan_id, recipe_id, meal_date, servings")
    .eq("household_id", householdId).eq("status", "accepted").gte("meal_date", addDays(start, -21));
  check(error, "Repas passés illisibles");
  const meals = (served ?? []) as Row[];
  const toMeal = (m: Row): ServedMeal => ({ recipeId: m.recipe_id, date: m.meal_date, servings: m.servings, slotId: m.id });
  const inPlan = (m: Row) => planId !== undefined && m.plan_id === planId;

  const proposals = await fetchAll((a, b) => supabase.from("meal_proposals").select("slot_id, recipe_id, decision")
    .eq("household_id", householdId).eq("decision", "rejected").range(a, b), "Refus illisibles");
  const rejected: Record<string, string[]> = {};
  const rejectionCounts: Record<string, number> = {};
  for (const p of proposals) {
    (rejected[p.slot_id] ??= []).push(p.recipe_id);
    rejectionCounts[p.recipe_id] = (rejectionCounts[p.recipe_id] ?? 0) + 1;
  }
  return {
    recipes, purchases, prefs, rejected, rejectionCounts,
    history: meals.filter((m) => !inPlan(m) && m.meal_date < start).map(toMeal),
    accepted: meals.filter(inPlan).map(toMeal),
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
  const { data: slots, error: e2 } = await supabase.from("meal_slots").upsert(requests.map((r) => ({
    plan_id: planId, household_id: householdId, meal_date: r.date, meal_type: r.mealType, max_total_min: r.maxTotalMin, servings: r.servings,
  })), { onConflict: "household_id,meal_date,meal_type" }).select("*");
  check(e2, "Repas non enregistrés");
  const keep = new Set(((slots ?? []) as Row[]).map((s) => s.id));
  const { data: existing, error: e3 } = await supabase.from("meal_slots").select("id, status").eq("plan_id", planId);
  check(e3, "Repas illisibles");
  const stale = ((existing ?? []) as Row[]).filter((s) => !keep.has(s.id) && s.status !== "accepted").map((s) => s.id);
  if (stale.length) {
    const { error: e4 } = await supabase.from("meal_slots").delete().in("id", stale);
    check(e4, "Repas non retirés");
  }
  return { planId, slots: ((slots ?? []) as Row[]).map(toSlot) };
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
}

/** Liste de courses comparée aux derniers tickets (articles achetés depuis leur ajout). */
export async function getShoppingList(supabase: SupabaseClient, householdId: string, sinceDays = 21): Promise<ShoppingItem[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data, error } = await supabase.from("shopping_list_status").select("*").eq("household_id", householdId)
    .gte("created_at", since).order("created_at", { ascending: false });
  check(error, "Liste de courses illisible");
  return ((data ?? []) as Row[]).map((i) => ({
    id: i.id, label: i.label, quantity: i.quantity === null ? null : Number(i.quantity), unit: i.unit, createdAt: i.created_at,
    checkedAt: i.checked_at, boughtAt: i.bought_at,
  }));
}

export async function setShoppingItemChecked(supabase: SupabaseClient, itemId: string, checked: boolean) {
  const { error } = await supabase.from("shopping_list_items").update({ checked_at: checked ? new Date().toISOString() : null }).eq("id", itemId);
  check(error, "Article non mis à jour");
}
