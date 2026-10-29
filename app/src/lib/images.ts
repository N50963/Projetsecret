/** Illustrations des recettes : image du foyer (photo ou image créée) sinon image commune, via des liens temporaires. */

import { supabase } from "./supabase";

const BUCKET = "recipe-images";
const cache = new Map<string, string | null>();

/** Liens d'affichage (1 h) pour plusieurs recettes ; null quand la recette n'a pas encore d'illustration. */
export async function illustrationUrls(recipeIds: string[]): Promise<Record<string, string | null>> {
  const missing = recipeIds.filter((id) => !cache.has(id));
  if (missing.length) {
    const { data } = await supabase.from("recipe_images").select("recipe_id, household_id, storage_path").in("recipe_id", missing);
    const best = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ recipe_id: string; household_id: string | null; storage_path: string }>) {
      if (row.household_id || !best.has(row.recipe_id)) best.set(row.recipe_id, row.storage_path);
    }
    const paths = [...best.values()];
    const signed = paths.length ? (await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)).data ?? [] : [];
    const urlOf = new Map(signed.map((s) => [s.path, s.signedUrl]));
    for (const id of missing) cache.set(id, best.has(id) ? urlOf.get(best.get(id)!) ?? null : null);
  }
  return Object.fromEntries(recipeIds.map((id) => [id, cache.get(id) ?? null]));
}

export function forgetIllustration(recipeId: string) {
  cache.delete(recipeId);
}

/** Photo prise ou choisie par le foyer : elle remplace l'illustration pour ce foyer. */
export async function uploadRecipePhoto(householdId: string, recipeId: string, uri: string, mimeType = "image/jpeg") {
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const path = `${householdId}/${recipeId}.${ext}`;
  const bytes = await (await fetch(uri)).arrayBuffer();
  const up = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: mimeType, upsert: true });
  if (up.error) throw new Error(`Photo non enregistrée : ${up.error.message}`);
  const { error } = await supabase.from("recipe_images").upsert({ recipe_id: recipeId, household_id: householdId, storage_path: path, source: "photo" },
    { onConflict: "recipe_id,household_id" });
  if (error) throw new Error(`Photo non associée à la recette : ${error.message}`);
  forgetIllustration(recipeId);
}
