/**
 * Classement des recettes par temps, choisi par le foyer (Profil › Recettes selon la météo) : temps froid (-2), plutôt
 * froid (-1), tout temps (0), plutôt chaud (1), temps chaud (2). Le moteur de menus s'en sert avec la météo prévue.
 */

import type { WeatherLevel } from "../modules/planning";
import { supabase } from "./supabase";

const PAGE = 1000;

/** Choix du foyer, par recette (les recettes absentes gardent le classement déduit de leur nom). */
export async function getWeatherLevels(householdId: string): Promise<Map<string, WeatherLevel>> {
  const out = new Map<string, WeatherLevel>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("recipe_weather").select("recipe_id, level")
      .eq("household_id", householdId).order("recipe_id").range(from, from + PAGE - 1);
    if (error) throw new Error(`Classement météo illisible : ${error.message}`);
    for (const row of data ?? []) out.set(row.recipe_id as string, row.level as WeatherLevel);
    if (!data || data.length < PAGE) return out;
  }
}

/** Enregistre le temps choisi pour une recette. */
export async function setWeatherLevel(householdId: string, recipeId: string, level: WeatherLevel): Promise<void> {
  const { error } = await supabase.from("recipe_weather").upsert(
    { household_id: householdId, recipe_id: recipeId, level, updated_at: new Date().toISOString() },
    { onConflict: "household_id,recipe_id" },
  );
  if (error) throw new Error(`Classement non enregistré : ${error.message}`);
}
