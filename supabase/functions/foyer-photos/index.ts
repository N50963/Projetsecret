/**
 * Fonction « foyer-photos » : visuels de plats fournis par le foyer, versionnés dans le dépôt public (data/photos-plats,
 * déjà réduits à 800 px), copiés comme image commune du plat (origine « foyer », sans crédit), à la place de la photo de
 * Commons. La date d'enregistrement renvoyée sert de version aux images embarquées dans l'application.
 * Vignettes d'ingrédients sur fond blanc (data/ingredients/<slug>.jpg, 160 px) : copiées à la place de la vignette en
 * ligne de l'ingrédient (ingredient-images/<slug>.jpg), crédits inchangés ; la nouvelle date sert de version.
 * Appel réservé aux tâches d'administration : jeton x-cron-token (app_settings.cron_token), comme les tâches planifiées.
 * Corps JSON : { ref: "<commit de 40 caractères>", recipes?: ["<id de recette>", ...], ingredients?: ["<slug>", ...] }.
 */

import { createClient } from "npm:@supabase/supabase-js@2.117.0";

const REPO = "https://raw.githubusercontent.com/n50963/projetsecret";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_BYTES = 400_000;
const MAX_INGREDIENT_BYTES = 100_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function envKey(jsonName: string, legacyName: string): string {
  try {
    const keys = JSON.parse(Deno.env.get(jsonName) ?? "{}");
    if (keys.default) return keys.default;
  } catch { /* variable absente ou ancienne forme */ }
  return Deno.env.get(legacyName) ?? "";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", envKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const expected = (await db.from("app_settings").select("value").eq("key", "cron_token").maybeSingle()).data?.value;
  if (!expected || req.headers.get("x-cron-token") !== expected) return json({ error: "Jeton invalide." }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Corps JSON attendu" }, 400);
  }
  const ref = String(body?.ref ?? "");
  if (!/^[0-9a-f]{40}$/.test(ref)) return json({ error: "Commit attendu (40 caractères hexadécimaux)." }, 400);
  const ids = Array.isArray(body?.recipes) ? (body.recipes as unknown[]).map(String).slice(0, 40) : [];

  const done: Array<{ recipe_id: string; created_at: string; kb: number }> = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("identifiant invalide");
      const r = await fetch(`${REPO}/${ref}/data/photos-plats/${id}.jpg`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`dépôt ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8) || bytes.length > MAX_BYTES) throw new Error("JPEG de 400 Ko au plus attendu");
      const path = `common/${id}.jpg`;
      const up = await db.storage.from("recipe-images").upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      if (up.error) throw new Error(up.error.message);
      const ins = await db.from("recipe_images").upsert({
        recipe_id: id, household_id: null, storage_path: path, source: "foyer", created_at: new Date().toISOString(),
        author: null, license: null, license_url: null, source_url: null,
      }, { onConflict: "recipe_id,household_id" }).select("created_at").single();
      if (ins.error) throw new Error(ins.error.message);
      done.push({ recipe_id: id, created_at: ins.data.created_at, kb: Math.round(bytes.length / 1024) });
    } catch (e) {
      failed.push(`${id} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const slugs = Array.isArray(body?.ingredients) ? (body.ingredients as unknown[]).map(String).slice(0, 80) : [];
  const ingredients: Array<{ slug: string; created_at: string; kb: number }> = [];
  for (const slug of slugs) {
    try {
      if (!/^[a-z0-9_]+$/.test(slug)) throw new Error("identifiant invalide");
      const ing = await db.from("ingredients").select("id").eq("slug", slug).maybeSingle();
      if (ing.error || !ing.data) throw new Error("ingrédient inconnu");
      const r = await fetch(`${REPO}/${ref}/data/ingredients/${slug}.jpg`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`dépôt ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8) || bytes.length > MAX_INGREDIENT_BYTES) throw new Error("JPEG de 100 Ko au plus attendu");
      const path = `${slug}.jpg`;
      const up = await db.storage.from("ingredient-images").upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      if (up.error) throw new Error(up.error.message);
      const upd = await db.from("ingredient_images").update({ storage_path: path, created_at: new Date().toISOString() })
        .eq("ingredient_id", ing.data.id).select("created_at").maybeSingle();
      if (upd.error || !upd.data) throw new Error(upd.error?.message ?? "vignette absente de la base");
      ingredients.push({ slug, created_at: upd.data.created_at, kb: Math.round(bytes.length / 1024) });
    } catch (e) {
      failed.push(`${slug} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return json({ done, ingredients, failed });
});
