/**
 * Illustrations : photos des plats et vignettes des ingrédients. Toutes sont dans Supabase ; aucune n'est livrée avec
 * l'application.
 * - Au lancement (et quand la liste en ligne change), les illustrations nouvelles ou modifiées sont téléchargées une fois
 *   dans le dossier permanent de l'application, avec une barre de mise à jour discrète en bas de l'écran
 *   (`useIllustrationUpdate`). Elles s'affichent ensuite depuis le téléphone : instantanément et sans réseau. Une nouvelle
 *   illustration ne demande donc pas de nouvelle version de l'application.
 * - Photos des plats : la photo en ligne (≈ 1 200 à 1 400 px, pour la fiche et les grandes cartes) et une miniature de
 *   480 px créée sur le téléphone (listes, ruban de la semaine, liste de courses) : nette en petit, décodée vite.
 * - Photos prises par le foyer (seau privé household-photos) : téléchargées par lien temporaire, gardées comme les autres.
 * - Une illustration du téléphone s'affiche toujours, nette, même si une version plus récente attend d'être téléchargée :
 *   la nouvelle la remplace dès son arrivée (`usePictures` fait redessiner les écrans). Seule une illustration absente du
 *   téléphone est lue en ligne. Les illustrations demandées par l'écran affiché sont téléchargées en premier.
 * - Version web (aperçus) : pas de fichiers ; les images sont lues en ligne et gardées par le navigateur.
 * Plan gratuit Supabase (5 Go de sortie réseau par mois) : chaque illustration n'est téléchargée qu'une fois par téléphone.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image, type ImageSource } from "expo-image";
import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { supabase } from "./supabase";

const PUBLIC_BUCKET = "recipe-images";
const PHOTO_BUCKET = "household-photos";
const INGREDIENT_BUCKET = "ingredient-images";
const PAGE = 1000;
const LINK_SECONDS = 7 * 24 * 3600;
const PHOTO_MAX_WIDTH = 1024;
/** Largeur des miniatures : nette dans le ruban de la semaine (98 × 84 points, image recadrée) jusqu'à 3 pixels par point. */
const MINI_WIDTH = 480;
/** Téléchargements en parallèle pendant la mise à jour. */
const PARALLEL = 6;
/** La liste en ligne est relue après ce délai (images créées entre-temps par la tâche planifiée ou par le foyer). */
const REFRESH_MS = 2 * 60 * 1000;
/** Après une mise à jour interrompue (réseau), nouvel essai au plus tôt après ce délai. */
const RETRY_MS = 10 * 60 * 1000;
const ONLINE_KEY = "illustrations-en-ligne-v1";
const LOCAL_KEY = "illustrations-telephone-v1";
const WEB = Platform.OS === "web";

/** Image à afficher : fichier du téléphone ou lien en ligne (clé de cache stable pour les liens temporaires). */
export interface Picture {
  uri: string;
  cacheKey?: string;
  /** Date de l'image en ligne : sa version. */
  version?: string;
  /** Photo du foyer (seau privé). */
  photo?: boolean;
  /** Miniature (fichier du téléphone) pour les petits affichages. */
  mini?: string;
  /** Image lue sur le téléphone (sans réseau). */
  local?: boolean;
}

/** Source pour expo-image : la miniature pour un petit affichage quand elle existe, sinon l'image. */
export const sourceOf = (p: Picture, small = false): ImageSource =>
  small && p.mini ? { uri: p.mini } : { uri: p.uri, cacheKey: p.cacheKey };

/** Image d'attente d'un grand affichage : la miniature du téléphone, décodée plus vite (aucune pour un petit affichage). */
export function placeholderOf(p: Picture, small = false): ImageSource | undefined {
  return !small && p.mini ? { uri: p.mini } : undefined;
}

// --- Listes : en ligne et sur le téléphone --------------------------------------------------------------------------

/** Illustration en ligne (seau, chemin, version). */
interface Online {
  bucket: string;
  path: string;
  version: string;
  /** Lien de téléchargement (public, ou temporaire pour les photos du foyer). */
  url: string;
  photo?: boolean;
}

/** Illustration gardée sur le téléphone. */
interface Local {
  version: string;
  file: string;
  mini?: string;
  /** Largeur de la miniature (absente : 240 px, versions 0.27 et 0.28). */
  miniWidth?: number;
}

interface ImageRow {
  recipe_id: string;
  household_id: string | null;
  storage_path: string;
  source: string;
  created_at: string;
}

let onlineDishes = new Map<string, Online>();
let onlineIngredients = new Map<string, Online>();
let localDishes: Record<string, Local> = {};
let localIngredients: Record<string, Local> = {};
let refreshedAt = 0;
let restored: Promise<void> | null = null;
let listing: Promise<void> | null = null;

function restore(): Promise<void> {
  restored ??= (async () => {
    try {
      const [online, local] = await Promise.all([AsyncStorage.getItem(ONLINE_KEY), AsyncStorage.getItem(LOCAL_KEY)]);
      if (online && !refreshedAt) {
        const o = JSON.parse(online) as { dishes: Array<[string, Online]>; ingredients: Array<[string, Online]> };
        onlineDishes = new Map(o.dishes);
        onlineIngredients = new Map(o.ingredients);
      }
      if (local) {
        const l = JSON.parse(local) as { dishes: Record<string, Local>; ingredients: Record<string, Local> };
        localDishes = l.dishes ?? {};
        localIngredients = l.ingredients ?? {};
      }
      // Listes des versions 0.26 et antérieures (images livrées avec l'application), devenues inutiles.
      AsyncStorage.multiRemove(["illustrations-v2", "ingredient-pictures-v1"]).catch(() => undefined);
    } catch {
      // Listes absentes ou illisibles : relues depuis Supabase.
    }
  })();
  return restored;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveLocal(now = false) {
  const write = () => {
    saveTimer = null;
    AsyncStorage.setItem(LOCAL_KEY, JSON.stringify({ dishes: localDishes, ingredients: localIngredients })).catch(() => undefined);
  };
  if (now) {
    if (saveTimer) clearTimeout(saveTimer);
    write();
  } else saveTimer ??= setTimeout(write, 1500);
}

/** Toutes les lignes d'une requête, par pages : Supabase renvoie au plus 1 000 lignes par requête. */
async function allRows<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await read(rows.length, rows.length + PAGE - 1);
    if (error) throw new Error(`${what} : ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return rows;
  }
}

const publicUrl = (bucket: string, path: string, version: string) =>
  `${supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl}?v=${encodeURIComponent(version)}`;

/** Relit la liste des illustrations en ligne (photos des plats, photos du foyer, vignettes des ingrédients). */
async function refresh() {
  const [images, ingredients] = await Promise.all([
    allRows<ImageRow>((a, b) => supabase.from("recipe_images").select("id, recipe_id, household_id, storage_path, source, created_at").order("id").range(a, b), "Images illisibles"),
    allRows<{ slug: string; storage_path: string; created_at: string }>((a, b) => supabase.from("ingredient_pictures").select("slug, storage_path, created_at").order("slug").range(a, b), "Vignettes illisibles"),
  ]);
  // L'image propre au foyer (photo, recette du foyer) l'emporte sur l'image commune.
  const best = new Map<string, ImageRow>();
  for (const row of images) if (row.household_id || !best.has(row.recipe_id)) best.set(row.recipe_id, row);
  const photos = [...best.values()].filter((r) => r.source === "photo").map((r) => r.storage_path);
  const signed = photos.length ? (await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(photos, LINK_SECONDS)).data ?? [] : [];
  const signedUrl = new Map(signed.map((s) => [s.path, s.signedUrl]));
  const dishes = new Map<string, Online>();
  for (const [recipeId, r] of best) {
    if (r.source === "photo") {
      const url = signedUrl.get(r.storage_path);
      if (url) dishes.set(recipeId, { bucket: PHOTO_BUCKET, path: r.storage_path, version: r.created_at, url, photo: true });
    } else {
      dishes.set(recipeId, { bucket: PUBLIC_BUCKET, path: r.storage_path, version: r.created_at, url: publicUrl(PUBLIC_BUCKET, r.storage_path, r.created_at) });
    }
  }
  const ing = new Map<string, Online>(ingredients.map((r) => [r.slug, {
    bucket: INGREDIENT_BUCKET, path: r.storage_path, version: r.created_at, url: publicUrl(INGREDIENT_BUCKET, r.storage_path, r.created_at),
  }]));
  onlineDishes = dishes;
  onlineIngredients = ing;
  refreshedAt = Date.now();
  changed(true);
  AsyncStorage.setItem(ONLINE_KEY, JSON.stringify({ dishes: [...dishes], ingredients: [...ing] })).catch(() => undefined);
}

/** Une seule lecture de la liste en ligne à la fois. */
function refreshList(): Promise<void> {
  listing ??= refresh().finally(() => {
    listing = null;
  });
  return listing;
}

/**
 * Image d'un plat : celle du téléphone, nette tout de suite, même quand une version plus récente est en cours de
 * téléchargement (elle la remplacera) ; sinon le lien en ligne.
 */
function resolve(recipeId: string): Picture | null {
  const local = localDishes[recipeId];
  if (local) return { uri: local.file, mini: local.mini, version: local.version, local: true };
  const online = onlineDishes.get(recipeId);
  if (!online) return null;
  return { uri: online.url, version: online.version, photo: online.photo, cacheKey: online.photo ? `${online.path}@${online.version}` : undefined };
}

// --- Écrans redessinés quand les illustrations du téléphone changent --------------------------------------------------

let epoch = 0;
const pictureListeners = new Set<() => void>();
let changeTimer: ReturnType<typeof setTimeout> | null = null;
/** Une illustration est arrivée ou la liste a changé : les écrans se redessinent (au plus une fois par seconde). */
function changed(now = false) {
  const fire = () => {
    changeTimer = null;
    epoch += 1;
    pictureListeners.forEach((l) => l());
  };
  if (now) {
    if (changeTimer) clearTimeout(changeTimer);
    fire();
  } else changeTimer ??= setTimeout(fire, 1000);
}

/**
 * À appeler dans un écran qui affiche des photos de plats (`pictureOf`) : il se redessine quand une illustration arrive
 * sur le téléphone. La valeur rendue change à chaque fois (à passer en `extraData` d'une FlatList).
 */
export function usePictures(): number {
  return useSyncExternalStore((l) => {
    pictureListeners.add(l);
    return () => {
      pictureListeners.delete(l);
    };
  }, () => epoch);
}

/** Ordre des illustrations demandées par l'écran affiché (la dernière demande compte) : téléchargées en premier. */
let wanted = new Map<string, number>();
function want(recipeIds: Array<string | null | undefined>) {
  const next = new Map<string, number>();
  recipeIds.forEach((id, i) => {
    if (id && !next.has(id)) next.set(id, i);
  });
  if (next.size) wanted = next;
}

// --- Mise à jour : téléchargement des illustrations nouvelles ou modifiées -------------------------------------------

/** État de la mise à jour, affiché par la barre du bas. */
export interface IllustrationUpdate {
  running: boolean;
  total: number;
  done: number;
  failed: number;
}

let update: IllustrationUpdate = { running: false, total: 0, done: 0, failed: 0 };
const listeners = new Set<() => void>();
function setUpdate(next: IllustrationUpdate) {
  update = next;
  listeners.forEach((l) => l());
}

/** Avancement de la mise à jour des illustrations (barre du bas). */
export function useIllustrationUpdate(): IllustrationUpdate {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, () => update);
}

interface Job {
  /** mini : nouvelle miniature d'une photo déjà sur le téléphone (sans réseau). */
  kind: "dish" | "ingredient" | "mini";
  key: string;
  online: Online;
}

const folder = (name: string) => {
  const dir = new Directory(Paths.document, "illustrations", name);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
};
/** Nom de fichier propre à chaque version : un affichage en mémoire ne garde jamais l'ancienne image. */
const fileName = (key: string, version: string) => `${key}-${Date.parse(version) || version.replace(/\W/g, "")}.jpg`;

function remove(uri: string | undefined) {
  if (!uri || WEB) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Fichier déjà absent.
  }
}

const present = (l: Local | undefined) => {
  if (!l) return false;
  if (WEB) return true;
  try {
    return new File(l.file).exists && (!l.mini || new File(l.mini).exists);
  } catch {
    return false;
  }
};

/** Miniature d'une photo de plat, créée sur le téléphone. */
async function makeMini(source: string, target: File): Promise<string> {
  const context = ImageManipulator.manipulate(source);
  context.resize({ width: MINI_WIDTH, height: null });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  const tmp = new File(saved.uri);
  await tmp.move(target, { overwrite: true });
  return target.uri;
}

async function download(job: Job): Promise<Local> {
  const { version, url } = job.online;
  if (job.kind === "mini") {
    // Photo déjà sur le téléphone : seule la miniature est refaite, sous un autre nom (l'ancienne reste affichée jusque-là).
    const l = localDishes[job.key]!;
    const mini = await makeMini(l.file, new File(folder("plats-mini"), fileName(job.key, l.version).replace(/\.jpg$/, `-${MINI_WIDTH}.jpg`)));
    return { ...l, mini, miniWidth: MINI_WIDTH };
  }
  if (WEB) {
    // Pas de fichiers : le navigateur garde l'image une fois téléchargée.
    await Image.prefetch(url, "disk");
    return { version, file: url };
  }
  const name = fileName(job.key, version);
  const target = new File(folder(job.kind === "dish" ? "plats" : "ingredients"), name);
  const file = await File.downloadFileAsync(url, target, { idempotent: true });
  if (job.kind === "ingredient") return { version, file: file.uri };
  const mini = await makeMini(file.uri, new File(folder("plats-mini"), name.replace(/\.jpg$/, `-${MINI_WIDTH}.jpg`)));
  return { version, file: file.uri, mini, miniWidth: MINI_WIDTH };
}

let syncing: Promise<void> | null = null;
let again = false;
let failedAt = 0;

async function runUpdate() {
  await restore();
  await refreshList();
  const jobs: Job[] = [];
  for (const [key, online] of onlineDishes) {
    const l = localDishes[key];
    if (!l || l.version !== online.version || !present(l)) {
      // Fichier disparu : l'image en ligne s'affiche en attendant le nouveau téléchargement.
      if (l && !present(l)) delete localDishes[key];
      jobs.push({ kind: "dish", key, online });
    } else if (!WEB && (l.miniWidth ?? 240) < MINI_WIDTH) jobs.push({ kind: "mini", key, online });
  }
  for (const [key, online] of onlineIngredients) {
    const l = localIngredients[key];
    if (!l || l.version !== online.version || !present(l)) jobs.push({ kind: "ingredient", key, online });
  }
  // Illustrations retirées en ligne (recette supprimée) : fichiers effacés.
  for (const [key, l] of Object.entries(localDishes)) if (!onlineDishes.has(key)) {
    remove(l.file);
    remove(l.mini);
    delete localDishes[key];
  }
  if (!jobs.length) {
    saveLocal(true);
    return;
  }
  let done = 0;
  let failed = 0;
  setUpdate({ running: true, total: jobs.length, done, failed });
  // Téléchargements d'abord (illustrations absentes ou modifiées), miniatures refaites ensuite.
  const queue = [...jobs.filter((j) => j.kind !== "mini"), ...jobs.filter((j) => j.kind === "mini")];
  /** Prochaine tâche : une illustration demandée par l'écran affiché, sinon la suivante de la file. */
  const take = () => {
    let best = -1;
    let rank = Infinity;
    queue.forEach((j, i) => {
      const r = j.kind === "ingredient" ? undefined : wanted.get(j.key);
      if (r !== undefined && r < rank) {
        rank = r;
        best = i;
      }
    });
    return best >= 0 ? queue.splice(best, 1)[0] : queue.shift();
  };
  const worker = async () => {
    for (let job = take(); job; job = take()) {
      try {
        const next = await download(job);
        const store = job.kind === "ingredient" ? localIngredients : localDishes;
        const old = store[job.key];
        store[job.key] = next;
        // Anciens fichiers effacés un peu plus tard : les écrans affichent encore l'ancienne version d'ici leur mise à jour.
        const stale = [old && old.file !== next.file ? old.file : undefined, old?.mini && old.mini !== next.mini ? old.mini : undefined];
        if (stale.some(Boolean)) setTimeout(() => stale.forEach(remove), 10_000);
        saveLocal();
        if (job.kind !== "ingredient") changed();
      } catch {
        failed += 1;
      }
      done += 1;
      setUpdate({ running: true, total: jobs.length, done, failed });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  saveLocal(true);
  if (failed) failedAt = Date.now();
  setUpdate({ running: false, total: jobs.length, done, failed });
}

/**
 * Met à jour les illustrations du téléphone : liste en ligne relue, nouvelles illustrations téléchargées. Une seule
 * mise à jour à la fois ; une demande pendant la mise à jour en relance une à la fin.
 */
export function updateIllustrations(): Promise<void> {
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = runUpdate()
    .catch(() => {
      failedAt = Date.now();
      if (update.running) setUpdate({ ...update, running: false });
    })
    .finally(() => {
      syncing = null;
      if (again) {
        again = false;
        updateIllustrations();
      }
    });
  return syncing;
}

/** Au lancement : listes du téléphone lues, puis mise à jour des illustrations. */
export function warmIllustrations(): void {
  restore().then(() => updateIllustrations()).catch(() => undefined);
}

/** Liste en ligne trop ancienne : nouvelle mise à jour (pas avant un délai après un échec réseau). */
function updateIfStale() {
  if (Date.now() - refreshedAt > REFRESH_MS && Date.now() - failedAt > RETRY_MS) updateIllustrations();
}

// --- Photos des plats ----------------------------------------------------------------------------------------------

/**
 * Images de recettes (null : pas encore créée). Répond tout de suite avec les listes du téléphone ; la première fois
 * seulement (aucune liste), attend la liste de Supabase.
 */
export async function illustrationUrls(recipeIds: string[]): Promise<Record<string, Picture | null>> {
  want(recipeIds);
  await restore();
  // Première ouverture (aucune liste) : la liste seulement, pas les téléchargements.
  if (!onlineDishes.size && !Object.keys(localDishes).length) await refreshList().catch(() => undefined);
  updateIfStale();
  return Object.fromEntries(recipeIds.map((id) => [id, resolve(id)]));
}

/** Image d'une recette connue du téléphone, sans attendre (null si elle n'est pas encore connue). */
export function pictureOf(recipeId: string | null | undefined): Picture | null {
  return recipeId ? resolve(recipeId) : null;
}

/** Met en mémoire les photos qui vont s'afficher (cartes des propositions, menus de la semaine). */
const inMemory = new Set<string>();
export function preloadPictures(recipeIds: Array<string | null | undefined>): void {
  want(recipeIds);
  const uris = [...new Set(recipeIds.map((id) => pictureOf(id)?.uri).filter((u): u is string => Boolean(u)))].filter((u) => !inMemory.has(u));
  if (!uris.length) return;
  uris.forEach((u) => inMemory.add(u));
  Image.prefetch(uris, "memory-disk").catch(() => uris.forEach((u) => inMemory.delete(u)));
}

/** Une image vient d'être créée ou remplacée : la liste sera relue et l'image téléchargée à la prochaine demande. */
export function forgetIllustration(_recipeId: string) {
  refreshedAt = 0;
  failedAt = 0;
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
  // La date sert de version : le téléphone télécharge la nouvelle photo.
  const { error } = await supabase.from("recipe_images").upsert({
    recipe_id: recipeId, household_id: householdId, storage_path: path, source: "photo", created_at: new Date().toISOString(),
  }, { onConflict: "recipe_id,household_id" });
  if (error) throw new Error(`Photo non associée à la recette : ${error.message}`);
  forgetIllustration(recipeId);
  await updateIllustrations();
  // Mise à jour déjà en cours au moment de l'envoi : la suivante (relancée à sa fin) télécharge la photo.
  if (syncing) await syncing;
}

// --- Vignettes des ingrédients ------------------------------------------------------------------------------------------

/** Crédit d'une photo d'ingrédient (Wikimedia Commons, licence libre). */
export interface IngredientCredit {
  slug: string;
  name: string;
  author: string | null;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
}

/** Vignettes des ingrédients par identifiant (slug) : fichier du téléphone, sinon lien en ligne. */
export async function ingredientPictureUrls(): Promise<Map<string, string>> {
  await restore();
  if (!onlineIngredients.size && !Object.keys(localIngredients).length) await refreshList().catch(() => undefined);
  const slugs = new Set([...onlineIngredients.keys(), ...Object.keys(localIngredients)]);
  return new Map([...slugs].map((s) => [s, ingredientSource(s)!.uri]));
}

/** Vignette d'un ingrédient sur fond blanc, sans attendre : fichier du téléphone, sinon (pas encore téléchargée) le lien. */
export function ingredientSource(slug: string | null | undefined): { uri: string } | null {
  if (!slug) return null;
  const local = localIngredients[slug];
  if (local) return { uri: local.file };
  const online = onlineIngredients.get(slug);
  return online ? { uri: online.url } : null;
}

/** Auteurs et licences des photos d'ingrédients (écran des crédits). */
export async function ingredientCredits(): Promise<IngredientCredit[]> {
  const { data, error } = await supabase.from("ingredient_pictures").select("slug, name, author, license, license_url, source_url").order("name");
  if (error) throw new Error(`Crédits illisibles : ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    slug: r.slug, name: r.name, author: r.author, license: r.license, licenseUrl: r.license_url, sourceUrl: r.source_url,
  }));
}

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

/** Ligne de crédit : « Photo : auteur · licence ». */
export const ingredientCredit = (c: IngredientCredit) => `Photo : ${c.author ? `${c.author} · ` : ""}${c.license} · Wikimedia Commons`;
