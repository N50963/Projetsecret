/**
 * Fonction serveur « mistral » : seul endroit où la clé Mistral est utilisée (secret MISTRAL_API_KEY).
 * Actions (corps JSON { action, household_id, ... }) :
 *  - status            : la clé est-elle configurée et quels modèles répondent (sans compte : modèles listés seulement) ;
 *  - import_recipe     : met en forme une recette collée en texte (ingrédients rattachés au référentiel) ;
 *  - generate_recipes  : propose de nouvelles recettes selon les notes du foyer, l'équilibre demandé et les achats récents ;
 *  - adapt_recipe      : adapte une recette d'après un avis (« trop sec », « sans champignons »...) ;
 *  - illustrate        : crée l'illustration d'une recette (génération d'image Mistral) et l'enregistre en JPEG ;
 *  - illustrate_missing: tâche planifiée (pg_cron, jeton x-cron-token) qui crée les illustrations manquantes (et remplace
 *                        celles de l'essai Pollinations), quelques-unes par passage, selon le quota gratuit de Mistral.
 * Les recettes renvoyées sont des brouillons : l'application les vérifie et les fait confirmer avant de les enregistrer.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.0";
import { decode as decodePng } from "npm:fast-png@6.2.0";
import jpeg from "npm:jpeg-js@0.4.4";

const MISTRAL = "https://api.mistral.ai/v1";
const TEXT_MODELS = (Deno.env.get("MISTRAL_TEXT_MODELS") ?? "mistral-small-latest,ministral-14b-latest,ministral-8b-latest").split(",").map((m) => m.trim());
const IMAGE_MODEL = Deno.env.get("MISTRAL_IMAGE_MODEL") ?? "mistral-medium-latest";
/** Appels par foyer et par heure, pour ménager le quota gratuit. */
const HOURLY_LIMIT = Number(Deno.env.get("MISTRAL_HOURLY_LIMIT") ?? "40");
/** Plan gratuit Supabase : une fonction dispose de 150 s ; chaque appel extérieur est borné pour répondre avant. */
const MISTRAL_TIMEOUT_MS = 100_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Journal des appels conservé 90 jours (taille de la base). */
const LOG_RETENTION_DAYS = 90;
/** Après un refus de Mistral (quota d'images de l'offre gratuite), plus aucune demande d'image pendant ce délai. */
const IMAGE_PAUSE_MS = 3600 * 1000;
/** Tâche planifiée : une nouvelle image n'est commencée que dans ce délai (une image prend 15 à 30 s, limite de 150 s). */
const BATCH_START_BUDGET_MS = 45_000;
/** Qualité JPEG des images enregistrées (≈ 150 Ko au lieu de 1,5 Mo en PNG : affichage rapide, plan gratuit Supabase). */
const JPEG_QUALITY = 85;

const UNITS = ["g", "ml", "piece", "cs", "cc", "pincee"];
const BASE_UNITS = ["g", "ml", "piece"];
const PROTEINS = ["volaille", "boeuf", "porc", "poisson", "fruits_de_mer", "oeuf", "legumineuse", "vegetarien"];
const SEASONS = ["printemps", "ete", "automne", "hiver"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function envKey(jsonName: string, legacyName: string): string {
  try {
    const keys = JSON.parse(Deno.env.get(jsonName) ?? "{}");
    if (keys.default) return keys.default;
  } catch { /* variable absente ou ancienne forme */ }
  return Deno.env.get(legacyName) ?? "";
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const admin = () => createClient(SUPABASE_URL, envKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// --- Mistral ---------------------------------------------------------------------------------------------------------

let workingModel: string | null = null;

async function mistralFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const key = Deno.env.get("MISTRAL_API_KEY");
  if (!key) throw new HttpError(503, "Clé Mistral absente : ajoutez le secret MISTRAL_API_KEY dans Supabase (Edge Functions > Secrets).");
  try {
    return await fetch(`${MISTRAL}${path}`, {
      ...init, signal: AbortSignal.timeout(MISTRAL_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new HttpError(504, "Mistral met trop de temps à répondre : réessayez.");
    throw e;
  }
}

/** Modèle bloqué par l'offre (limite à 0) ou momentanément saturé : on passe au suivant. */
const unavailable = (r: Response) => r.status === 429 || r.status === 403 || r.headers.get("x-ratelimit-limit-req-minute") === "0";

async function chatJson(messages: Array<{ role: string; content: string }>, temperature: number): Promise<{ data: any; model: string }> {
  const models = workingModel ? [workingModel, ...TEXT_MODELS.filter((m) => m !== workingModel)] : TEXT_MODELS;
  let last = "";
  for (const model of models) {
    const r = await mistralFetch("/chat/completions", {
      method: "POST", body: JSON.stringify({ model, messages, temperature, response_format: { type: "json_object" } }),
    });
    if (unavailable(r)) {
      last = `${model} : ${r.status}`;
      await r.body?.cancel();
      continue;
    }
    if (!r.ok) throw new HttpError(502, `Mistral a refusé la demande (${r.status}) : ${(await r.text()).slice(0, 300)}`);
    const body = await r.json();
    workingModel = model;
    const content = body.choices?.[0]?.message?.content ?? "";
    try {
      return { data: JSON.parse(content), model };
    } catch {
      throw new HttpError(502, "Réponse de Mistral illisible (JSON attendu).");
    }
  }
  throw new HttpError(429, `Aucun modèle Mistral disponible avec cette clé pour le moment (${last}).`);
}

// --- Recettes ----------------------------------------------------------------------------------------------------------

interface Ref { slug: string; name: string; default_unit: string; category: string }

const RECIPE_FORMAT = `Format JSON d'une recette :
{"name": "...", "description": "une phrase", "servings": 4, "prep_min": 15, "cook_min": 20, "rest_min": 0, "difficulty": 1,
 "meal_types": ["diner"], "main_protein": "${PROTEINS.join("|")}", "cuisine": "francaise", "seasons": ["${SEASONS.join('", "')}"],
 "tags": [], "steps": ["étape 1", "étape 2"],
 "ingredients": [{"slug": "slug du référentiel ou null", "label": "libellé lisible", "quantity": 200, "unit": "${UNITS.join("|")}",
   "base_quantity": 200, "base_unit": "g|ml|piece ou null", "optional": false, "scale": "linear|sublinear|fixed"}]}
Règles : plat principal uniquement (pas d'entrée, de dessert, de fromage ni de petit-déjeuner) ; meal_types parmi "diner" et "dejeuner" ;
difficulty de 1 à 3 ; quantités pour le nombre de portions ; base_quantity = quantité en g, ml ou pièces quand la conversion est sûre
(sinon null) ; cuillères (cs, cc) et pincées : base_quantity null sauf liquides (1 cs = 15 ml, 1 cc = 5 ml) ; épices et herbes en "sublinear" ;
au moins 3 ingrédients et 2 étapes ; étapes courtes, à l'impératif. Portions généreuses par personne : 120 à 150 g de viande ou de poisson,
150 à 250 g de légumes, 70 à 80 g de féculent cru (pâtes, riz, semoule) ou 250 g de pommes de terre.`;

function referentialText(refs: Ref[]) {
  return refs.map((r) => `${r.slug} (${r.name}, ${r.default_unit})`).join("; ");
}

/** Remet en forme un brouillon de recette et liste ce qui reste à corriger. */
function normalizeRecipe(raw: any, refs: Ref[]): { recipe: any; issues: string[] } {
  const known = new Set(refs.map((r) => r.slug));
  const unitOf = new Map(refs.map((r) => [r.slug, r.default_unit]));
  const issues: string[] = [];
  const int = (v: unknown, d: number, min: number, max: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const pick = <T,>(v: unknown, allowed: T[], d: T) => (allowed.includes(v as T) ? (v as T) : d);
  const r = {
    name: String(raw?.name ?? "").trim().slice(0, 120),
    description: raw?.description ? String(raw.description).trim().slice(0, 300) : null,
    servings: int(raw?.servings, 4, 1, 20),
    prep_min: int(raw?.prep_min, 15, 0, 300),
    cook_min: int(raw?.cook_min, 0, 0, 600),
    rest_min: int(raw?.rest_min, 0, 0, 1440),
    difficulty: int(raw?.difficulty, 1, 1, 3),
    meal_types: (Array.isArray(raw?.meal_types) ? raw.meal_types : ["diner"]).filter((m: string) => ["diner", "dejeuner"].includes(m)),
    main_protein: pick(raw?.main_protein, PROTEINS, "vegetarien"),
    cuisine: raw?.cuisine ? String(raw.cuisine).slice(0, 40) : null,
    seasons: (Array.isArray(raw?.seasons) ? raw.seasons : SEASONS).filter((s: string) => SEASONS.includes(s)),
    tags: (Array.isArray(raw?.tags) ? raw.tags : []).map(String).slice(0, 10),
    steps: (Array.isArray(raw?.steps) ? raw.steps : []).map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 20),
    ingredients: [] as any[],
  };
  if (!r.meal_types.length) r.meal_types = ["diner"];
  if (!r.seasons.length) r.seasons = [...SEASONS];
  const seen = new Set<string>();
  for (const i of Array.isArray(raw?.ingredients) ? raw.ingredients : []) {
    let slug = i?.slug && known.has(String(i.slug)) ? String(i.slug) : null;
    if (slug && seen.has(slug)) slug = null;
    if (slug) seen.add(slug);
    const label = String(i?.label ?? i?.slug ?? "").trim().slice(0, 120);
    if (!label) continue;
    const q = Number(i?.quantity);
    const bq = Number(i?.base_quantity);
    r.ingredients.push({
      slug, label, quantity: Number.isFinite(q) && q > 0 ? q : null, unit: UNITS.includes(i?.unit) ? i.unit : null,
      base_quantity: Number.isFinite(bq) && bq > 0 ? bq : null, base_unit: BASE_UNITS.includes(i?.base_unit) ? i.base_unit : null,
      optional: Boolean(i?.optional), scale: pick(i?.scale, ["linear", "sublinear", "fixed"], "linear"),
    });
    const last = r.ingredients.at(-1);
    // La quantité de référence n'est utile que dans l'unité du référentiel (celle des achats) : sinon, présence seulement.
    if (last.base_quantity === null || (last.slug && last.base_unit !== unitOf.get(last.slug))) {
      last.base_quantity = null;
      last.base_unit = null;
    }
  }
  if (!r.name) issues.push("nom manquant");
  if (r.ingredients.length < 3) issues.push("moins de 3 ingrédients");
  if (r.steps.length < 2) issues.push("moins de 2 étapes");
  const unmapped = r.ingredients.filter((i) => !i.slug).map((i) => i.label);
  if (unmapped.length) issues.push(`ingrédients hors référentiel (non comparés aux achats) : ${unmapped.join(", ")}`);
  return { recipe: r, issues };
}

// --- Contexte du foyer ---------------------------------------------------------------------------------------------------

async function householdContext(db: SupabaseClient, householdId: string) {
  const since = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const [prefs, ratings, bought] = await Promise.all([
    db.from("household_preferences").select("*").eq("household_id", householdId).maybeSingle(),
    db.from("recipe_ratings").select("rating, recipe_id").eq("household_id", householdId).order("rated_at", { ascending: false }).limit(60),
    db.from("purchased_ingredients").select("ingredient_name").eq("household_id", householdId).gte("purchased_at", since).limit(500),
  ]);
  const ids = [...new Set((ratings.data ?? []).map((r: any) => r.recipe_id))];
  const names = ids.length ? (await db.from("recipe_catalog").select("id, name").in("id", ids)).data ?? [] : [];
  const nameOf = new Map(names.map((n: any) => [n.id, n.name]));
  const rated = (kind: string) => [...new Set((ratings.data ?? []).filter((r: any) => r.rating === kind).map((r: any) => nameOf.get(r.recipe_id)).filter(Boolean))];
  const p = prefs.data;
  const lines = [
    p ? `Foyer : ${p.adults} adultes, ${p.teens} adolescent(s), ${p.children} enfant(s).` : "Foyer de 4 personnes.",
    p?.excluded_allergens?.length ? `Allergènes à exclure : ${p.excluded_allergens.join(", ")}.` : "Pas d'allergie déclarée.",
    p?.excluded_food_groups?.length ? `Jamais : ${p.excluded_food_groups.join(", ")}.` : "",
    p?.spice_level === "aucun" ? "Rien d'épicé." : p?.spice_level === "doux" ? "Épices douces seulement (curry doux, paprika, chorizo doux), rien de piquant." : "",
    p?.disliked_ingredients?.length ? `Ingrédients non appréciés : ${p.disliked_ingredients.join(", ")}.` : "",
    rated("like").length ? `Plats aimés : ${rated("like").slice(0, 15).join(", ")}.` : "",
    rated("dislike").length ? `Plats pas aimés : ${rated("dislike").slice(0, 15).join(", ")}.` : "",
    (bought.data ?? []).length ? `Achats des 10 derniers jours : ${[...new Set((bought.data ?? []).map((b: any) => b.ingredient_name))].join(", ")}.` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

// --- Illustrations -------------------------------------------------------------------------------------------------------

async function imageAgent(db: SupabaseClient): Promise<string> {
  const { data } = await db.from("app_settings").select("value").eq("key", "mistral_image_agent").maybeSingle();
  if (data?.value) return data.value;
  const r = await mistralFetch("/agents", {
    method: "POST",
    body: JSON.stringify({
      model: IMAGE_MODEL, name: "Illustrations de recettes", tools: [{ type: "image_generation" }],
      instructions: "Tu crées une seule image par demande : une photographie culinaire réaliste et appétissante du plat décrit, sans texte ni logo.",
    }),
  });
  if (!r.ok) throw new HttpError(r.status === 429 || r.status === 403 ? 429 : 502, `Création d'images indisponible avec cette clé (${r.status}).`);
  const agent = await r.json();
  await db.from("app_settings").upsert({ key: "mistral_image_agent", value: agent.id, updated_at: new Date().toISOString() });
  return agent.id;
}

/** Lien de l'image produite par l'outil (la réponse de l'outil contient {"url": ...}). */
function findImageUrl(conv: any): string | null {
  for (const o of conv.outputs ?? []) {
    if (o.type !== "tool.execution") continue;
    const result = o.info?.result;
    try {
      const url = (typeof result === "string" ? JSON.parse(result) : result)?.url;
      if (typeof url === "string" && url.startsWith("https://")) return url;
    } catch { /* résultat non JSON : recherche du lien ci-dessous */ }
    const match = JSON.stringify(o.info ?? {}).match(/https:\/\/[^"\\\s]+/);
    if (match) return match[0];
  }
  return null;
}

/** Premier fichier produit par un outil (l'image), où qu'il soit dans la réponse. */
function findToolFile(node: any): { file_id: string } | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "tool_file" && node.file_id) return node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findToolFile(value);
    if (found) return found;
  }
  return null;
}

/** Image créée par Mistral (agent avec l'outil de génération d'images). */
async function mistralImage(db: SupabaseClient, prompt: string): Promise<Uint8Array> {
  const pause = (await db.from("app_settings").select("value").eq("key", "mistral_image_pause_until").maybeSingle()).data?.value;
  if (pause && Date.parse(pause) > Date.now()) {
    throw new HttpError(429, `Création d'images Mistral en pause jusqu'à ${new Date(pause).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })} (quota gratuit).`);
  }
  const agentId = await imageAgent(db);
  const r = await mistralFetch("/conversations", { method: "POST", body: JSON.stringify({ agent_id: agentId, inputs: prompt }) });
  if (!r.ok) {
    if (unavailable(r)) {
      await db.from("app_settings").upsert({ key: "mistral_image_pause_until", value: new Date(Date.now() + IMAGE_PAUSE_MS).toISOString(),
        updated_at: new Date().toISOString() });
    }
    // Le message de Mistral indique la limite atteinte (gardé dans le journal ai_calls).
    throw new HttpError(unavailable(r) ? 429 : 502, `Création d'images indisponible avec cette clé (${r.status} : ${(await r.text()).slice(0, 160)}).`);
  }
  const conv = await r.json();
  const chunk = findToolFile(conv);
  const url = chunk?.file_id ? null : findImageUrl(conv);
  if (!chunk?.file_id && !url) {
    const shape = (conv.outputs ?? []).map((o: any) => o.type === "tool.execution"
      ? `outil ${o.name ?? ""} ${JSON.stringify(o.info ?? o.arguments ?? {}).slice(0, 120)}`
      : `${o.type} ${typeof o.content === "string" ? o.content.slice(0, 160) : JSON.stringify(o.content).slice(0, 160)}`);
    throw new HttpError(502, `Mistral n'a pas renvoyé d'image (${shape.join(" | ").slice(0, 280)}).`);
  }
  const file = chunk?.file_id ? await mistralFetch(`/files/${chunk.file_id}/content`, { headers: { Accept: "*/*" } })
    : await fetch(url!, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!file.ok) throw new HttpError(502, `Image non téléchargée (${file.status}).`);
  return new Uint8Array(await file.arrayBuffer());
}

/** Image enregistrée en JPEG (les PNG de Mistral pèsent ≈ 10 fois plus). */
function asJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return bytes;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return bytes;
  const png = decodePng(bytes);
  const { width, height, channels } = png;
  const rgba = new Uint8Array(width * height * 4);
  const data = png.data as Uint8Array;
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    rgba[i * 4] = data[j];
    rgba[i * 4 + 1] = data[channels >= 3 ? j + 1 : j];
    rgba[i * 4 + 2] = data[channels >= 3 ? j + 2 : j];
    rgba[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data: rgba, width, height }, JPEG_QUALITY).data;
}

async function illustrate(reader: SupabaseClient, recipeId: string): Promise<{ path: string }> {
  const db = admin();
  const { data: recipe, error } = await reader.from("recipe_catalog").select("id, household_id, name, description, version_id").eq("id", recipeId).maybeSingle();
  if (error || !recipe) throw new HttpError(404, "Recette introuvable.");
  const { data: ings } = await reader.from("recipe_ingredients").select("label, optional").eq("version_id", recipe.version_id).order("position");
  const ingredients = (ings ?? []).filter((i: any) => !i.optional).map((i: any) => i.label).join(", ");
  const prompt = `Génère une image avec l'outil de génération d'images. Photographie culinaire réaliste, vue de trois-quarts, lumière naturelle, assiette familiale simple : « ${recipe.name} ». `
    + `${recipe.description ?? ""} Ingrédients : ${ingredients}. Pas de texte.`;
  const bytes = asJpeg(await mistralImage(db, prompt));
  if (bytes.length > 5_000_000) throw new HttpError(502, "Image trop lourde.");
  // Format réel d'après les premiers octets (l'en-tête HTTP du lien n'est pas fiable).
  const contentType = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg"
    : bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45 ? "image/webp" : "image/png";
  const owner = recipe.household_id ?? null;
  const path = `${owner ?? "common"}/${recipe.id}.${contentType === "image/jpeg" ? "jpg" : contentType.slice(6)}`;
  const up = await db.storage.from("recipe-images").upload(path, bytes, { contentType, upsert: true });
  if (up.error) throw new HttpError(500, `Image non enregistrée : ${up.error.message}`);
  // La date sert de version pour le cache des téléphones.
  const ins = await db.from("recipe_images").upsert({ recipe_id: recipe.id, household_id: owner, storage_path: path, source: "mistral",
    created_at: new Date().toISOString() }, { onConflict: "recipe_id,household_id" });
  if (ins.error) throw new HttpError(500, `Image non référencée : ${ins.error.message}`);
  return { path };
}

/**
 * Crée les illustrations manquantes, une à la fois, jusqu'à un échec (quota Mistral) ou à la fin du temps imparti.
 * Les images de l'essai Pollinations comptent comme manquantes : elles restent affichées jusqu'à leur remplacement.
 */
async function illustrateMissing(db: SupabaseClient) {
  const started = Date.now();
  const [recipes, images] = await Promise.all([
    db.from("recipe_catalog").select("id, name").order("name"),
    db.from("recipe_images").select("recipe_id, source"),
  ]);
  const have = new Set((images.data ?? []).filter((i: any) => i.source !== "pollinations").map((i: any) => i.recipe_id));
  const missing = (recipes.data ?? []).filter((r: any) => !have.has(r.id));
  const log = (ok: boolean, model: string | null, detail?: string) =>
    db.from("ai_calls").insert({ action: "illustrate_missing", model, ok, detail: detail?.slice(0, 300) });
  let created = 0;
  for (const recipe of missing) {
    if (Date.now() - started > BATCH_START_BUDGET_MS) break;
    try {
      await illustrate(db, recipe.id);
      await log(true, IMAGE_MODEL, recipe.name);
      created++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await log(false, null, `${recipe.name} : ${message}`);
      return { created, remaining: missing.length - created, stopped: message };
    }
  }
  return { created, remaining: missing.length - created };
}

// --- Point d'entrée --------------------------------------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps JSON attendu" }, 400);
  }

  if (body.action === "illustrate_missing") {
    try {
      const db = admin();
      const expected = (await db.from("app_settings").select("value").eq("key", "cron_token").maybeSingle()).data?.value;
      if (!expected || req.headers.get("x-cron-token") !== expected) throw new HttpError(401, "Jeton de tâche planifiée invalide.");
      return json(await illustrateMissing(db));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
    }
  }

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const user = createClient(SUPABASE_URL, envKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"), {
    auth: { persistSession: false }, global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });
  const claims = token ? (await user.auth.getClaims(token)).data?.claims : null;
  const userId = typeof claims?.sub === "string" && claims.role === "authenticated" ? claims.sub : null;

  try {
    if (body.action === "status" && !userId) {
      const r = await mistralFetch("/models");
      return json({ configured: true, key_valid: r.ok, signed_in: false });
    }
    if (!userId) throw new HttpError(401, "Connexion requise.");
    const householdId = String(body.household_id ?? "");
    const member = await user.from("household_members").select("household_id").eq("household_id", householdId).eq("user_id", userId).maybeSingle();
    if (!member.data) throw new HttpError(403, "Ce compte n'appartient pas à ce foyer.");

    const db = admin();
    const { count } = await db.from("ai_calls").select("id", { count: "exact", head: true }).eq("household_id", householdId)
      .gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
    if ((count ?? 0) >= HOURLY_LIMIT) throw new HttpError(429, "Trop de demandes à Mistral cette heure-ci : réessayez plus tard.");
    if (Math.random() < 0.05) {
      await db.from("ai_calls").delete().lt("created_at", new Date(Date.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString());
    }
    const log = (ok: boolean, model: string | null, detail?: string) =>
      db.from("ai_calls").insert({ household_id: householdId, user_id: userId, action: String(body.action), model, ok, detail: detail?.slice(0, 300) });

    try {
      const refs = ((await user.from("ingredients").select("slug, name, default_unit, category").order("slug")).data ?? []) as Ref[];
      const system = { role: "system", content: `Tu es l'assistant culinaire d'une application de menus familiaux. Tu réponds uniquement en JSON.\n${RECIPE_FORMAT}\nRéférentiel d'ingrédients (slug, nom, unité) : ${referentialText(refs)}` };

      if (body.action === "status") {
        const { model } = await chatJson([{ role: "user", content: 'Réponds {"ok": true}' }], 0);
        await log(true, model);
        return json({ configured: true, key_valid: true, signed_in: true, text_model: model, image_model: IMAGE_MODEL });
      }
      if (body.action === "import_recipe") {
        const text = String(body.text ?? "").slice(0, 12000);
        if (text.trim().length < 40) throw new HttpError(400, "Collez le texte complet de la recette.");
        const { data, model } = await chatJson([system, { role: "user", content:
          `Mets en forme cette recette pour ${body.servings ?? 4} personnes, en gardant ses quantités et ses étapes (traduis en français si besoin). `
          + `Rattache chaque ingrédient au slug le plus proche du référentiel, ou null. Réponds {"recipe": {...}}.\n\n${text}` }], 0.2);
        const out = normalizeRecipe(data.recipe ?? data, refs);
        await log(true, model);
        return json({ ...out, model });
      }
      if (body.action === "generate_recipes") {
        const count = Math.min(3, Math.max(1, Number(body.count ?? 3)));
        const context = await householdContext(user, householdId);
        const c = body.constraints ?? {};
        const constraints = [
          c.max_total_min ? `Temps total (préparation + cuisson) : ${c.max_total_min} minutes au plus.` : "",
          c.main_protein ? `Protéine principale : ${c.main_protein}.` : "",
          c.season ? `Saison : ${c.season}.` : "",
          c.meal_type === "dejeuner" ? "Pour un déjeuner." : "Pour un dîner.",
          c.avoid?.length ? `Ne pas proposer : ${c.avoid.slice(0, 40).join(", ")}.` : "",
        ].filter(Boolean).join(" ");
        const { data, model } = await chatJson([system, { role: "user", content:
          `${context}\n${constraints}\nObjectifs d'équilibre à respecter : ${String(body.brief ?? "repas variés, légumes à chaque repas").slice(0, 600)}\n`
          + `Propose ${count} recettes différentes, simples et familiales, pour ${body.servings ?? 4} personnes. Les objectifs d'équilibre et `
          + `la protéine demandée sont prioritaires ; ensuite, privilégie les achats récents et le style des plats aimés, et évite ce qui ressemble `
          + `aux plats pas aimés. Chaque ingrédient cité dans les étapes figure dans la liste avec sa quantité. Réponds {"recipes": [...]}.` }], 0.5);
        let recipes = (Array.isArray(data.recipes) ? data.recipes : []).slice(0, count).map((r: any) => normalizeRecipe(r, refs));
        const matching = (list: any[]) => list.filter((r: any) => r.recipe.main_protein === c.main_protein);
        if (c.main_protein && !matching(recipes).length) {
          // Les petits modèles oublient parfois la protéine demandée : une seconde demande plus directive.
          const retry = await chatJson([system, { role: "user", content:
            `${context}\n${constraints}\nPropose ${count} recettes familiales pour ${body.servings ?? 4} personnes dont l'ingrédient principal est `
            + `${c.main_protein === "poisson" ? "un poisson" : c.main_protein} : chaque recette a "main_protein": "${c.main_protein}". Réponds {"recipes": [...]}.` }], 0.3);
          recipes = (Array.isArray(retry.data.recipes) ? retry.data.recipes : []).slice(0, count).map((r: any) => normalizeRecipe(r, refs));
        }
        if (c.main_protein && matching(recipes).length) recipes = matching(recipes);
        await log(true, model);
        return json({ recipes, model });
      }
      if (body.action === "adapt_recipe") {
        const feedback = String(body.feedback ?? "").slice(0, 1000);
        if (!feedback.trim()) throw new HttpError(400, "Indiquez ce qu'il faut changer.");
        const context = await householdContext(user, householdId);
        const { data, model } = await chatJson([system, { role: "user", content:
          `${context}\nAdapte cette recette selon l'avis du foyer : « ${feedback} ». Garde ce qui plaît, change ce qui est demandé, `
          + `et respecte l'équilibre (légumes, cuisson saine). Réponds {"recipe": {...}, "change_note": "résumé des changements"}.\n\n`
          + JSON.stringify(body.recipe ?? {}).slice(0, 8000) }], 0.4);
        const out = normalizeRecipe(data.recipe ?? data, refs);
        await log(true, model);
        return json({ ...out, change_note: String(data.change_note ?? feedback).slice(0, 300), model });
      }
      if (body.action === "illustrate") {
        const result = await illustrate(user, String(body.recipe_id ?? ""));
        await log(true, IMAGE_MODEL);
        return json(result);
      }
      throw new HttpError(400, "Action inconnue.");
    } catch (e) {
      await log(false, null, e instanceof Error ? e.message : String(e));
      throw e;
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
