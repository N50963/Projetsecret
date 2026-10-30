/**
 * Photos des plats, affichées immédiatement.
 * - Images créées par Mistral (seau public recipe-images) : lien public stable, mis en cache par le CDN de Supabase et par le
 *   téléphone. Toutes sont téléchargées en avance, une seule fois par téléphone : ensuite elles s'affichent sans attente.
 * - Photos prises par le foyer (seau privé household-photos) : liens temporaires de 7 jours, cache sous une clé stable.
 * La liste des images est gardée sur le téléphone (AsyncStorage) : à l'ouverture, les photos s'affichent sans attendre
 * Supabase ; la liste est rafraîchie en arrière-plan (nouvelles images de la tâche planifiée).
 * Plan gratuit Supabase (5 Go de sortie réseau par mois) : chaque image n'est téléchargée qu'une fois par téléphone.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { supabase } from "./supabase";

const PUBLIC_BUCKET = "recipe-images";
const PHOTO_BUCKET = "household-photos";
const LINK_SECONDS = 7 * 24 * 3600;
const PHOTO_MAX_WIDTH = 1024;
/** La liste des images est relue après ce délai (images créées entre-temps par la tâche planifiée). */
const REFRESH_MS = 2 * 60 * 1000;
const STORAGE_KEY = "illustrations-v2";

/** Image à afficher ; la clé de cache n'est utile qu'aux liens temporaires (photos du foyer). */
export interface Picture {
  uri: string;
  cacheKey?: string;
}

interface ImageRow {
  recipe_id: string;
  household_id: string | null;
  storage_path: string;
  source: "mistral" | "photo";
  created_at: string;
}

let pictures = new Map<string, Picture>();
let refreshedAt = 0;
let restored: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
const prefetched = new Set<string>();

function restore(): Promise<void> {
  restored ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (raw && !refreshedAt) pictures = new Map(JSON.parse(raw) as Array<[string, Picture]>);
    })
    .catch(() => undefined);
  return restored;
}

async function refresh() {
  const { data, error } = await supabase.from("recipe_images").select("recipe_id, household_id, storage_path, source, created_at");
  if (error) throw new Error(`Images illisibles : ${error.message}`);
  // L'image propre au foyer (photo, recette du foyer) l'emporte sur l'image commune.
  const best = new Map<string, ImageRow>();
  for (const row of (data ?? []) as ImageRow[]) if (row.household_id || !best.has(row.recipe_id)) best.set(row.recipe_id, row);
  const photos = [...best.values()].filter((r) => r.source === "photo").map((r) => r.storage_path);
  const signed = photos.length ? (await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(photos, LINK_SECONDS)).data ?? [] : [];
  const signedUrl = new Map(signed.map((s) => [s.path, s.signedUrl]));
  const next = new Map<string, Picture>();
  for (const [recipeId, r] of best) {
    if (r.source === "photo") {
      const uri = signedUrl.get(r.storage_path);
      if (uri) next.set(recipeId, { uri, cacheKey: `${r.storage_path}@${r.created_at}` });
    } else {
      // La date sert de version : une image recréée change de lien, donc de cache.
      const url = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(r.storage_path).data.publicUrl;
      next.set(recipeId, { uri: `${url}?v=${encodeURIComponent(r.created_at)}` });
    }
  }
  pictures = next;
  refreshedAt = Date.now();
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...pictures])).catch(() => undefined);
  // Téléchargement en avance des images publiques pas encore en cache sur ce téléphone.
  const toFetch = [...pictures.values()].filter((p) => !p.cacheKey && !prefetched.has(p.uri)).map((p) => p.uri);
  if (toFetch.length) {
    toFetch.forEach((u) => prefetched.add(u));
    Image.prefetch(toFetch, "disk").catch(() => undefined);
  }
}

/**
 * Images de recettes (null : pas encore créée). Répond tout de suite avec la liste gardée sur le téléphone et la rafraîchit
 * en arrière-plan ; la première fois seulement, attend la liste de Supabase.
 */
export async function illustrationUrls(recipeIds: string[]): Promise<Record<string, Picture | null>> {
  await restore();
  if (Date.now() - refreshedAt > REFRESH_MS) {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    if (pictures.size === 0) await refreshing.catch(() => undefined);
    else refreshing.catch(() => undefined);
  }
  return Object.fromEntries(recipeIds.map((id) => [id, pictures.get(id) ?? null]));
}

/** Une image vient d'être créée ou remplacée : la liste sera relue à la prochaine demande. */
export function forgetIllustration(_recipeId: string) {
  refreshedAt = 0;
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
  const up = await supabase.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (up.error) throw new Error(`Photo non enregistrée : ${up.error.message}`);
  // La date sert de version : le cache des téléphones prend la nouvelle photo.
  const { error } = await supabase.from("recipe_images").upsert({
    recipe_id: recipeId, household_id: householdId, storage_path: path, source: "photo", created_at: new Date().toISOString(),
  }, { onConflict: "recipe_id,household_id" });
  if (error) throw new Error(`Photo non associée à la recette : ${error.message}`);
  forgetIllustration(recipeId);
  await refresh();
}
