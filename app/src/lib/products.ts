/**
 * Produits des tickets Lidl : vérification des nouveaux produits à l'import et corrections du foyer (rôle, ingrédients).
 * Une correction vaut pour tous les achats du produit, passés et futurs : le stock et les menus en tiennent compte.
 */

import { supabase } from "./supabase";

export type ProductRole = "ingredient" | "prepared_meal" | "dessert" | "snack" | "breakfast" | "beverage" | "bread" | "non_food";

export const ROLE_LABELS: Record<ProductRole, string> = {
  ingredient: "Ingrédient", prepared_meal: "Plat tout prêt", dessert: "Dessert", snack: "Grignotage", breakfast: "Petit-déjeuner",
  beverage: "Boisson", bread: "Pain", non_food: "Non alimentaire",
};
export const ROLES = Object.keys(ROLE_LABELS) as ProductRole[];

export interface ShopProduct {
  id: string;
  labelRaw: string;
  name: string;
  role: ProductRole | null;
  ingredients: string[];
  /** Rôle ou ingrédient non trouvé par MenuBily. */
  unknown: boolean;
  lastSeen: string | null;
  timesBought: number;
}

export interface IngredientOption {
  slug: string;
  name: string;
}

/** Nouveaux produits à vérifier, les non reconnus d'abord. */
export async function productsToReview(householdId: string): Promise<ShopProduct[]> {
  const { data, error } = await supabase.from("products_to_review")
    .select("id, label_raw, display_name, role, ingredient_slugs, unknown, last_seen, times_bought")
    .eq("household_id", householdId).order("unknown", { ascending: false }).order("last_seen", { ascending: false }).limit(100);
  if (error) throw new Error(`Produits illisibles : ${error.message}`);
  return (data ?? []).map((p: any) => ({
    id: p.id, labelRaw: p.label_raw, name: p.display_name, role: p.role, ingredients: p.ingredient_slugs ?? [], unknown: Boolean(p.unknown),
    lastSeen: p.last_seen, timesBought: p.times_bought ?? 0,
  }));
}

export async function countToReview(householdId: string): Promise<number> {
  const { count, error } = await supabase.from("products_to_review").select("id", { count: "exact", head: true }).eq("household_id", householdId);
  if (error) return 0;
  return count ?? 0;
}

/** Recherche d'un produit déjà acheté, pour corriger ce que MenuBily en a compris. */
export async function searchProducts(householdId: string, text: string): Promise<ShopProduct[]> {
  const q = text.trim().replace(/[%_,()]/g, " ");
  if (q.length < 2) return [];
  const { data, error } = await supabase.from("products")
    .select("id, label_raw, display_name, role, last_seen, times_bought, product_ingredients(ingredients(slug))")
    .eq("household_id", householdId).eq("kind", "food").or(`display_name.ilike.%${q}%,label_raw.ilike.%${q}%`)
    .order("last_seen", { ascending: false, nullsFirst: false }).limit(20);
  if (error) throw new Error(`Recherche impossible : ${error.message}`);
  return (data ?? []).map((p: any) => {
    const ingredients = (p.product_ingredients ?? []).map((pi: any) => pi.ingredients?.slug).filter(Boolean) as string[];
    return {
      id: p.id, labelRaw: p.label_raw, name: p.display_name, role: p.role, ingredients,
      unknown: !p.role || (p.role === "ingredient" && !ingredients.length), lastSeen: p.last_seen, timesBought: p.times_bought ?? 0,
    };
  });
}

let options: Promise<IngredientOption[]> | null = null;

/** Référentiel des ingrédients (choix proposés à la correction). */
export function ingredientOptions(): Promise<IngredientOption[]> {
  options ??= (async () => {
    const { data, error } = await supabase.from("ingredients").select("slug, name").order("name");
    if (error) throw new Error(`Ingrédients illisibles : ${error.message}`);
    return (data ?? []) as IngredientOption[];
  })().catch((e) => {
    options = null;
    throw e;
  });
  return options;
}

/** Comparaison sans accents ni majuscules. */
export const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export async function correctProduct(id: string, name: string, role: ProductRole, ingredients: string[]): Promise<void> {
  const { error } = await supabase.rpc("correct_product", {
    p_product: id, p_display_name: name, p_role: role, p_ingredients: role === "ingredient" ? ingredients : [],
  });
  if (error) throw new Error(error.message);
}

/** Produits bien compris, validés tels quels. */
export async function confirmProducts(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase.rpc("confirm_products", { p_products: ids });
  if (error) throw new Error(error.message);
}
