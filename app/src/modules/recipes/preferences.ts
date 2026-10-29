/**
 * Préférences alimentaires du foyer (table household_preferences). La base les applique d'elle-même aux propositions
 * de recettes (allergènes exclus, niveau d'épice) ; l'application les lit pour l'affichage et les modifie.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Spiciness } from "./types";

/** aucun : ni curry ni chorizo ni piment ; doux : curry et chorizo doux, rien de piquant ; tout : pas de limite. */
export type SpiceLevel = "aucun" | "doux" | "tout";
export type FoodGroup = "abats" | "coquillages" | "crustaces" | "porc" | "boeuf" | "agneau" | "poisson" | "champignons";

export interface HouseholdPreferences {
  adults: number;
  teens: number;
  children: number;
  excludedAllergens: string[];
  excludedFoodGroups: FoodGroup[];
  dislikedIngredients: string[];
  spiceLevel: SpiceLevel;
  meatlessDinnersMin: number;
  meatlessDinnersMax: number;
  shoppingIntervalDays: number;
  shopsOutsideLidl: boolean;
  freezesFreshMeatFish: boolean;
  pantryConfirmedAt: string | null;
}

/** Valeurs par défaut de la base, pour un foyer qui n'a encore rien renseigné. */
export const DEFAULT_PREFERENCES: HouseholdPreferences = {
  adults: 2, teens: 0, children: 0, excludedAllergens: [], excludedFoodGroups: [], dislikedIngredients: [], spiceLevel: "tout",
  meatlessDinnersMin: 0, meatlessDinnersMax: 7, shoppingIntervalDays: 7, shopsOutsideLidl: false, freezesFreshMeatFish: false,
  pantryConfirmedAt: null,
};

/** Niveau d'épice le plus élevé accepté (même règle que recipe_candidates). */
export function maxSpicinessFor(level: SpiceLevel): Spiciness {
  return level === "aucun" ? 0 : level === "doux" ? 1 : 2;
}

type Row = Record<string, any>;

function fromRow(r: Row): HouseholdPreferences {
  return {
    adults: r.adults, teens: r.teens, children: r.children, excludedAllergens: r.excluded_allergens, excludedFoodGroups: r.excluded_food_groups,
    dislikedIngredients: r.disliked_ingredients, spiceLevel: r.spice_level, meatlessDinnersMin: r.meatless_dinners_min,
    meatlessDinnersMax: r.meatless_dinners_max, shoppingIntervalDays: r.shopping_interval_days, shopsOutsideLidl: r.shops_outside_lidl,
    freezesFreshMeatFish: r.freezes_fresh_meat_fish, pantryConfirmedAt: r.pantry_confirmed_at,
  };
}

export function toPreferencesRow(householdId: string, p: HouseholdPreferences) {
  return {
    household_id: householdId, adults: p.adults, teens: p.teens, children: p.children, excluded_allergens: p.excludedAllergens,
    excluded_food_groups: p.excludedFoodGroups, disliked_ingredients: p.dislikedIngredients, spice_level: p.spiceLevel,
    meatless_dinners_min: p.meatlessDinnersMin, meatless_dinners_max: p.meatlessDinnersMax, shopping_interval_days: p.shoppingIntervalDays,
    shops_outside_lidl: p.shopsOutsideLidl, freezes_fresh_meat_fish: p.freezesFreshMeatFish, pantry_confirmed_at: p.pantryConfirmedAt,
    updated_at: new Date().toISOString(),
  };
}

export async function getHouseholdPreferences(supabase: SupabaseClient, householdId: string): Promise<HouseholdPreferences> {
  const { data, error } = await supabase.from("household_preferences").select("*").eq("household_id", householdId).maybeSingle();
  if (error) throw new Error(`Préférences illisibles : ${error.message}`);
  return data ? fromRow(data as Row) : { ...DEFAULT_PREFERENCES };
}

export async function saveHouseholdPreferences(supabase: SupabaseClient, householdId: string, prefs: HouseholdPreferences): Promise<void> {
  if (prefs.meatlessDinnersMin > prefs.meatlessDinnersMax) throw new Error("Préférences invalides : minimum de dîners sans viande supérieur au maximum");
  const { error } = await supabase.from("household_preferences").upsert(toPreferencesRow(householdId, prefs), { onConflict: "household_id" });
  if (error) throw new Error(`Préférences non enregistrées : ${error.message}`);
}
