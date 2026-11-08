/**
 * Achats de fruits et légumes faits ailleurs que chez Lidl (marché, primeur, autre magasin), saisis à la main
 * (Profil › Tickets et achats). Table extra_purchases ; la vue purchased_ingredients les ajoute aux achats des tickets :
 * ils comptent de la même façon dans le stock des propositions de menus, la liste de courses et la recherche par
 * ingrédient.
 */

import { BUNCH, type FreshCategory, type FreshProduct } from "./freshQuantity";
import { supabase } from "./supabase";

export { BUNCH, defaultQuantity, quantityLabel, stepQuantity, type FreshCategory, type FreshProduct } from "./freshQuantity";

/** Produits transformés ou trop vagues pour un achat au marché. */
const EXCLUDED = new Set(["fruit_divers", "poire_au_sirop", "coeur_palmier", "mais", "legumes_melange", "ratatouille"]);
/** Herbes fraîches vendues en bouquet. */
const HERBS = ["persil", "basilic", "coriandre", "ciboulette", "herbes_fraiches"];
/** Noms plus parlants au marché que ceux du référentiel. */
const NAMES: Record<string, string> = {
  betterave: "Betterave", champignon: "Champignons", artichaut: "Artichaut", herbes_fraiches: "Menthe, aneth…",
  oignon_nouveau: "Oignons nouveaux", radis: "Radis", petit_pois: "Petits pois", haricot_vert: "Haricots verts",
  haricot_beurre: "Haricots beurre", chou_bruxelles: "Choux de Bruxelles", fruits_rouges: "Fruits rouges",
};


/** Fruits, légumes et herbes fraîches du référentiel, par ordre alphabétique. */
export async function listFreshProducts(): Promise<FreshProduct[]> {
  const { data, error } = await supabase.from("ingredients").select("id, slug, name, category, default_unit")
    .or(`category.in.(legume,fruit),slug.in.(${HERBS.join(",")})`).order("name");
  if (error) throw new Error(`Fruits et légumes illisibles : ${error.message}`);
  return ((data ?? []) as Array<Record<string, string>>)
    .filter((r) => !EXCLUDED.has(r.slug!))
    .map((r) => ({
      id: r.id!, slug: r.slug!, name: NAMES[r.slug!] ?? r.name!,
      category: (HERBS.includes(r.slug!) ? "herbe" : r.category) as FreshCategory,
      unit: r.default_unit === "piece" ? "piece" as const : "g" as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/** Achat saisi à la main. */
export interface ExtraPurchase {
  id: string;
  slug: string;
  name: string;
  quantity: number;
  unit: "g" | "piece";
  purchasedAt: string;
  store: string | null;
}

/** Achats saisis à la main depuis `days` jours, du plus récent au plus ancien. */
export async function listExtraPurchases(householdId: string, days = 30): Promise<ExtraPurchase[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabase.from("extra_purchases").select("id, quantity, unit, purchased_at, store, ingredients(slug, name)")
    .eq("household_id", householdId).gte("purchased_at", since).order("purchased_at", { ascending: false }).limit(200);
  if (error) throw new Error(`Achats illisibles : ${error.message}`);
  return ((data ?? []) as Array<Record<string, any>>).map((r) => {
    const ing = Array.isArray(r.ingredients) ? r.ingredients[0] : r.ingredients;
    return {
      id: r.id, slug: ing?.slug ?? "", name: NAMES[ing?.slug] ?? ing?.name ?? "", quantity: Number(r.quantity),
      unit: r.unit === "piece" ? "piece" : "g", purchasedAt: r.purchased_at, store: r.store ?? null,
    };
  });
}

/** Enregistre les achats choisis (quantité dans l'unité de référence de chaque produit). */
export async function addExtraPurchases(householdId: string, items: Array<{ product: FreshProduct; quantity: number }>, purchasedAt: Date, store: string) {
  if (!items.length) return;
  const { error } = await supabase.from("extra_purchases").insert(items.map(({ product, quantity }) => ({
    household_id: householdId, ingredient_id: product.id, quantity, unit: product.unit,
    purchased_at: purchasedAt.toISOString(), store: store.trim().slice(0, 60) || null,
  })));
  if (error) throw new Error(`Achats non enregistrés : ${error.message}`);
}

/** Retire un achat saisi par erreur. */
export async function deleteExtraPurchase(id: string) {
  const { error } = await supabase.from("extra_purchases").delete().eq("id", id);
  if (error) throw new Error(`Achat non retiré : ${error.message}`);
}

