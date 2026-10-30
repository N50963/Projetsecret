/**
 * Illustrations des recettes : image du foyer (photo ou image créée) sinon image commune.
 * Plan gratuit Supabase (5 Go de sortie réseau par mois) : chaque téléphone ne télécharge une image qu'une fois.
 * Les liens d'accès durent 7 jours et l'image est mise en cache sur le téléphone sous une clé stable (chemin + version),
 * indépendante du jeton du lien. Les photos sont réduites avant envoi (1 024 px de large, JPEG).
 */

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { supabase } from "./supabase";

const BUCKET = "recipe-images";
const LINK_SECONDS = 7 * 24 * 3600;
/** Un lien est redemandé un jour avant son expiration. */
const RENEW_MS = (LINK_SECONDS - 24 * 3600) * 1000;
const PHOTO_MAX_WIDTH = 1024;

/** Image à afficher : lien temporaire et clé de cache stable. */
export interface Picture {
  uri: string;
  cacheKey: string;
}

const cache = new Map<string, { picture: Picture | null; at: number }>();

export async function illustrationUrls(recipeIds: string[]): Promise<Record<string, Picture | null>> {
  const now = Date.now();
  const missing = recipeIds.filter((id) => {
    const hit = cache.get(id);
    return !hit || (hit.picture !== null && now - hit.at > RENEW_MS);
  });
  if (missing.length) {
    const { data } = await supabase.from("recipe_images").select("recipe_id, household_id, storage_path, created_at").in("recipe_id", missing);
    const best = new Map<string, { path: string; version: string }>();
    for (const row of (data ?? []) as Array<{ recipe_id: string; household_id: string | null; storage_path: string; created_at: string }>) {
      if (row.household_id || !best.has(row.recipe_id)) best.set(row.recipe_id, { path: row.storage_path, version: row.created_at });
    }
    const paths = [...new Set([...best.values()].map((b) => b.path))];
    const signed = paths.length ? (await supabase.storage.from(BUCKET).createSignedUrls(paths, LINK_SECONDS)).data ?? [] : [];
    const urlOf = new Map(signed.map((s) => [s.path, s.signedUrl]));
    for (const id of missing) {
      const b = best.get(id);
      const uri = b ? urlOf.get(b.path) : undefined;
      cache.set(id, { picture: b && uri ? { uri, cacheKey: `${b.path}@${b.version}` } : null, at: now });
    }
  }
  return Object.fromEntries(recipeIds.map((id) => [id, cache.get(id)?.picture ?? null]));
}

export function forgetIllustration(recipeId: string) {
  cache.delete(recipeId);
}

/** Réduit une photo du téléphone (souvent 3 à 5 Mo) à 1 024 px de large en JPEG (≈ 150 à 250 Ko). */
async function shrinkPhoto(uri: string, width: number | undefined): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  if (!width || width > PHOTO_MAX_WIDTH) context.resize({ width: PHOTO_MAX_WIDTH, height: null });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
  return saved.uri;
}

/** Photo prise ou choisie par le foyer : elle remplace l'illustration pour ce foyer. */
export async function uploadRecipePhoto(householdId: string, recipeId: string, uri: string, width?: number) {
  const path = `${householdId}/${recipeId}.jpg`;
  const bytes = await (await fetch(await shrinkPhoto(uri, width))).arrayBuffer();
  const up = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (up.error) throw new Error(`Photo non enregistrée : ${up.error.message}`);
  // La date sert de version : le cache des téléphones prend la nouvelle photo.
  const { error } = await supabase.from("recipe_images").upsert({
    recipe_id: recipeId, household_id: householdId, storage_path: path, source: "photo", created_at: new Date().toISOString(),
  }, { onConflict: "recipe_id,household_id" });
  if (error) throw new Error(`Photo non associée à la recette : ${error.message}`);
  forgetIllustration(recipeId);
}
