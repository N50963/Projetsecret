/**
 * Fonction serveur « mistral » : seul endroit où la clé Mistral est utilisée (secret MISTRAL_API_KEY).
 * Actions (corps JSON { action, household_id, ... }) :
 *  - status            : la clé est-elle configurée et quels modèles répondent (sans compte : modèles listés seulement) ;
 *  - import_recipe     : met en forme une recette collée en texte (ingrédients rattachés au référentiel) ;
 *  - generate_recipes  : propose de nouvelles recettes selon les notes du foyer, l'équilibre demandé et les achats récents ;
 *  - adapt_recipe      : adapte une recette d'après un avis (« trop sec », « sans champignons »...) ;
 *  - illustrate        : crée l'illustration d'une recette (génération d'image Mistral) et l'enregistre.
 * Les recettes renvoyées sont des brouillons : l'application les vérifie et les fait confirmer avant de les enregistrer.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.0";

const MISTRAL = "https://api.mistral.ai/v1";
const TEXT_MODELS = (Deno.env.get("MISTRAL_TEXT_MODELS") ?? "mistral-small-latest,ministral-8b-latest").split(",").map((m) => m.trim());
const IMAGE_MODEL = Deno.env.get("MISTRAL_IMAGE_MODEL") ?? "mistral-medium-latest";
/** Appels par foyer et par heure, pour ménager le quota gratuit. */
const HOURLY_LIMIT = Number(Deno.env.get("MISTRAL_HOURLY_LIMIT") ?? "40");

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
  return await fetch(`${MISTRAL}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers } });
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
au moins 3 ingrédients et 2 étapes ; étapes courtes, à l'impératif.`;

function referentialText(refs: Ref[]) {
  return refs.map((r) => `${r.slug} (${r.name}, ${r.default_unit})`).join("; ");
}

/** Remet en forme un brouillon de recette et liste ce qui reste à corriger. */
function normalizeRecipe(raw: any, refs: Ref[]): { recipe: any; issues: string[] } {
  const known = new Set(refs.map((r) => r.slug));
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
    if (r.ingredients.at(-1).base_quantity === null) r.ingredients.at(-1).base_unit = null;
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

async function illustrate(user: SupabaseClient, householdId: string, recipeId: string) {
  const { data: recipe, error } = await user.from("recipe_catalog").select("id, household_id, name, description").eq("id", recipeId).maybeSingle();
  if (error || !recipe) throw new HttpError(404, "Recette introuvable.");
  const { data: ings } = await user.from("recipe_ingredients").select("label, optional").eq("version_id",
    (await user.from("recipe_catalog").select("version_id").eq("id", recipeId).single()).data?.version_id).order("position");
  const db = admin();
  const agentId = await imageAgent(db);
  const prompt = `Photographie culinaire réaliste, vue de trois-quarts, lumière naturelle, assiette familiale simple : « ${recipe.name} ». `
    + `${recipe.description ?? ""} Ingrédients : ${(ings ?? []).filter((i: any) => !i.optional).map((i: any) => i.label).join(", ")}. Pas de texte.`;
  const r = await mistralFetch("/conversations", { method: "POST", body: JSON.stringify({ agent_id: agentId, inputs: prompt }) });
  if (!r.ok) throw new HttpError(unavailable(r) ? 429 : 502, `Création d'images indisponible avec cette clé (${r.status}).`);
  const conv = await r.json();
  const chunk = (conv.outputs ?? []).flatMap((o: any) => (Array.isArray(o.content) ? o.content : [])).find((c: any) => c.type === "tool_file");
  if (!chunk?.file_id) throw new HttpError(502, "Mistral n'a pas renvoyé d'image.");
  const file = await mistralFetch(`/files/${chunk.file_id}/content`, { headers: { Accept: "*/*" } });
  if (!file.ok) throw new HttpError(502, `Image non téléchargée (${file.status}).`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const owner = recipe.household_id ?? null;
  const path = `${owner ?? "common"}/${recipe.id}.png`;
  const up = await db.storage.from("recipe-images").upload(path, bytes, { contentType: "image/png", upsert: true });
  if (up.error) throw new HttpError(500, `Image non enregistrée : ${up.error.message}`);
  const ins = await db.from("recipe_images").upsert({ recipe_id: recipe.id, household_id: owner, storage_path: path, source: "mistral" },
    { onConflict: "recipe_id,household_id" });
  if (ins.error) throw new HttpError(500, `Image non référencée : ${ins.error.message}`);
  return { path };
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
          + `Propose ${count} recettes différentes, simples et familiales, pour ${body.servings ?? 4} personnes, en privilégiant les achats récents `
          + `et le style des plats aimés, en évitant ce qui ressemble aux plats pas aimés. Réponds {"recipes": [...]}.` }], 0.8);
        const recipes = (Array.isArray(data.recipes) ? data.recipes : []).slice(0, count).map((r: any) => normalizeRecipe(r, refs));
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
        const result = await illustrate(user, householdId, String(body.recipe_id ?? ""));
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
