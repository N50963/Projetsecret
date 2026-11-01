/**
 * Photos des plats, affichées immédiatement.
 * - Photos embarquées dans l'application (src/lib/bundled.ts) : affichées sans réseau tant que l'image en ligne n'a pas
 *   changé (même date) ; une image plus récente (recréée, nouvelle recette) est téléchargée à la place.
 * - Images créées par Mistral ou photos libres (seau public recipe-images) : lien public stable, mis en cache par le CDN de
 *   Supabase et par le téléphone, téléchargées en avance une seule fois par téléphone.
 * - Photos prises par le foyer (seau privé household-photos) : liens temporaires de 7 jours, cache sous une clé stable.
 * La liste des images est gardée sur le téléphone (AsyncStorage) : à l'ouverture, les photos s'affichent sans attendre
 * Supabase ; la liste est rafraîchie en arrière-plan (nouvelles images de la tâche planifiée).
 * Plan gratuit Supabase (5 Go de sortie réseau par mois) : chaque image n'est téléchargée qu'une fois par téléphone.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { BUNDLED_DISHES, BUNDLED_INGREDIENTS } from "./bundled";
import { supabase } from "./supabase";

const PUBLIC_BUCKET = "recipe-images";
const PHOTO_BUCKET = "household-photos";
const LINK_SECONDS = 7 * 24 * 3600;
const PHOTO_MAX_WIDTH = 1024;
/** La liste des images est relue après ce délai (images créées entre-temps par la tâche planifiée). */
const REFRESH_MS = 2 * 60 * 1000;
const STORAGE_KEY = "illustrations-v2";

/** Image à afficher : image embarquée (asset) ou lien ; la clé de cache n'est utile qu'aux liens temporaires (photos du foyer). */
export interface Picture {
  uri: string;
  cacheKey?: string;
  /** Image embarquée dans l'application (affichage instantané, sans réseau). */
  asset?: number;
  /** Date de l'image en ligne (comparée à celle de l'image embarquée). */
  version?: string;
  /** Photo du foyer (seau privé). */
  photo?: boolean;
  /** Miniature embarquée (240 px) pour les petits affichages : listes, ruban de la semaine, liste de courses. */
  mini?: number;
  /**
   * Image embarquée affichée tout de suite pendant le téléchargement d'une image en ligne plus récente (image recréée ou
   * photo du foyer) : rien ne reste vide.
   */
  fallback?: number;
}

/**
 * Source d'image pour expo-image : l'image embarquée si elle existe (sa miniature pour un petit affichage), sinon le lien.
 */
export const sourceOf = (p: Picture, small = false) => (small && p.mini) || p.asset || { uri: p.uri, cacheKey: p.cacheKey };

/** Image embarquée si l'image en ligne est la même (ou pas encore connue), sinon l'image en ligne, avec l'image embarquée
 * en attente de son téléchargement. */
function resolve(recipeId: string, remote: Picture | undefined): Picture | null {
  const bundled = BUNDLED_DISHES[recipeId];
  if (bundled && (!remote || (!remote.photo && remote.version === bundled.version))) return { uri: "", asset: bundled.asset, mini: bundled.mini };
  if (remote && bundled) return { ...remote, fallback: bundled.mini };
  return remote ?? null;
}

interface ImageRow {
  recipe_id: string;
  household_id: string | null;
  storage_path: string;
  source: "mistral" | "photo" | "commons" | "gemini" | "pollinations";
  created_at: string;
}

let pictures = new Map<string, Picture>();
let refreshedAt = 0;
let restored: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
const prefetched = new Set<string>();
const inMemory = new Set<string>();

function restore(): Promise<void> {
  restored ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      // Les images embarquées ne sont pas gardées (leur numéro change d'une version de l'application à l'autre).
    if (raw && !refreshedAt) pictures = new Map((JSON.parse(raw) as Array<[string, Picture]>).filter(([, p]) => !p.asset));
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
      if (uri) next.set(recipeId, { uri, cacheKey: `${r.storage_path}@${r.created_at}`, photo: true, version: r.created_at });
    } else {
      // La date sert de version : une image recréée change de lien, donc de cache.
      const url = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(r.storage_path).data.publicUrl;
      next.set(recipeId, { uri: `${url}?v=${encodeURIComponent(r.created_at)}`, version: r.created_at });
    }
  }
  pictures = next;
  refreshedAt = Date.now();
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...pictures])).catch(() => undefined);
  // Téléchargement en avance des images publiques pas encore en cache sur ce téléphone (hors images embarquées).
  const toFetch = [...pictures.entries()].map(([id, p]) => resolve(id, p)).filter((p): p is Picture => Boolean(p))
    .filter((p) => !p.asset && !p.cacheKey && !prefetched.has(p.uri)).map((p) => p.uri);
  if (toFetch.length) {
    toFetch.forEach((u) => prefetched.add(u));
    Image.prefetch(toFetch, "disk").catch(() => undefined);
  }
}

/**
 * Images de recettes (null : pas encore créée). Répond tout de suite avec les images embarquées et la liste gardée sur le
 * téléphone, et la rafraîchit en arrière-plan ; la première fois seulement, attend la liste de Supabase s'il le faut.
 */
export async function illustrationUrls(recipeIds: string[]): Promise<Record<string, Picture | null>> {
  await restore();
  if (Date.now() - refreshedAt > REFRESH_MS) {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    // Première ouverture : attendre la liste en ligne seulement pour les recettes sans image embarquée.
    if (pictures.size === 0 && recipeIds.some((id) => !BUNDLED_DISHES[id])) await refreshing.catch(() => undefined);
    else refreshing.catch(() => undefined);
  }
  return Object.fromEntries(recipeIds.map((id) => [id, resolve(id, pictures.get(id))]));
}

/**
 * Image d'une recette connue de ce téléphone, sans attendre Supabase (null si elle n'est pas encore connue). Sert à
 * afficher les photos au premier rendu ; `illustrationUrls` met la liste à jour en arrière-plan.
 */
export function pictureOf(recipeId: string | null | undefined): Picture | null {
  return recipeId ? resolve(recipeId, pictures.get(recipeId)) : null;
}

/** Charge la liste gardée sur le téléphone, puis la rafraîchit et télécharge en avance toutes les photos (au démarrage). */
export function warmIllustrations(): void {
  illustrationUrls([]).catch(() => undefined);
  ingredientPictureUrls().catch(() => undefined);
}

/**
 * Met en mémoire les photos qui vont s'afficher (cartes des propositions, menus de la semaine) : elles apparaissent
 * alors instantanément, sans relecture du disque ni téléchargement.
 */
export function preloadPictures(recipeIds: Array<string | null | undefined>): void {
  const uris = [...new Set(recipeIds.map((id) => pictureOf(id)).filter((p) => p && !p.asset).map((p) => p!.uri).filter(Boolean))]
    .filter((u) => !inMemory.has(u));
  if (!uris.length) return;
  uris.forEach((u) => inMemory.add(u));
  Image.prefetch(uris, "memory-disk").catch(() => uris.forEach((u) => inMemory.delete(u)));
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

// --- Vignettes des ingrédients ------------------------------------------------------------------------------------------

const INGREDIENT_BUCKET = "ingredient-images";
const INGREDIENT_KEY = "ingredient-pictures-v1";

/** Crédit d'une photo d'ingrédient (Wikimedia Commons, licence libre). */
export interface IngredientCredit {
  slug: string;
  name: string;
  author: string | null;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
}

let ingredientPictures = new Map<string, string>();
let ingredientsLoaded: Promise<void> | null = null;

async function loadIngredientPictures() {
  try {
    const raw = await AsyncStorage.getItem(INGREDIENT_KEY);
    if (raw) ingredientPictures = new Map(JSON.parse(raw) as Array<[string, string]>);
  } catch {
    // Liste absente : relue depuis Supabase ci-dessous.
  }
  const refresh = (async () => {
    const { data, error } = await supabase.from("ingredient_pictures").select("slug, storage_path, created_at");
    if (error || !data) return;
    const next = new Map<string, string>();
    for (const row of data as Array<{ slug: string; storage_path: string; created_at: string }>) {
      const url = supabase.storage.from(INGREDIENT_BUCKET).getPublicUrl(row.storage_path).data.publicUrl;
      next.set(row.slug, `${url}?v=${encodeURIComponent(row.created_at)}`);
    }
    ingredientPictures = next;
    AsyncStorage.setItem(INGREDIENT_KEY, JSON.stringify([...next])).catch(() => undefined);
    // Vignettes en ligne seulement pour les ingrédients sans image embarquée.
    const remote = [...next.entries()].filter(([slug]) => !BUNDLED_INGREDIENTS[slug]).map(([, uri]) => uri);
    if (remote.length) Image.prefetch(remote, "disk").catch(() => undefined);
  })();
  if (!ingredientPictures.size) await refresh;
}

/** Vignettes des ingrédients par identifiant (slug) ; la liste est gardée sur le téléphone. */
export async function ingredientPictureUrls(): Promise<Map<string, string>> {
  ingredientsLoaded ??= loadIngredientPictures();
  await ingredientsLoaded;
  return ingredientPictures;
}

/**
 * Vignette d'un ingrédient sur fond blanc, sans attendre : image embarquée dans l'application, sinon (ingrédient ajouté
 * depuis) la vignette en ligne déjà connue du téléphone.
 */
export function ingredientSource(slug: string | null | undefined): number | { uri: string } | null {
  if (!slug) return null;
  const bundled = BUNDLED_INGREDIENTS[slug];
  if (bundled) return bundled;
  const uri = ingredientPictures.get(slug);
  return uri ? { uri } : null;
}

/** Auteurs et licences des photos d'ingrédients (écran des crédits). */
export async function ingredientCredits(): Promise<IngredientCredit[]> {
  const { data, error } = await supabase.from("ingredient_pictures").select("slug, name, author, license, license_url, source_url").order("name");
  if (error) throw new Error(`Crédits illisibles : ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    slug: r.slug, name: r.name, author: r.author, license: r.license, licenseUrl: r.license_url, sourceUrl: r.source_url,
  }));
}

/** Ligne de crédit : « Photo : auteur · licence ». */
/** Photos libres des plats (Wikimedia Commons), avec leurs crédits. */
export interface DishCredit {
  recipeId: string;
  name: string;
  author: string | null;
  license: string;
  sourceUrl: string;
}

export async function dishCredits(): Promise<DishCredit[]> {
  const { data, error } = await supabase.from("dish_photo_credits").select("recipe_id, name, author, license, source_url").order("name");
  if (error) throw new Error(`Crédits illisibles : ${error.message}`);
  return (data ?? []).map((d: any) => ({ recipeId: d.recipe_id, name: d.name, author: d.author, license: d.license ?? "", sourceUrl: d.source_url ?? "" }));
}

export const ingredientCredit = (c: IngredientCredit) => `Photo : ${c.author ? `${c.author} · ` : ""}${c.license} · Wikimedia Commons`;
