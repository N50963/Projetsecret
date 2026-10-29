/**
 * Lecture des ingrédients achetés, pour les stocks et la préparation des repas.
 * Les quantités sont en g, ml ou pièces ; `quantity` est nulle quand la contenance du produit est inconnue,
 * et `quantityConfidence` < 0,85 signale un format à confirmer (plusieurs formats possibles).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface IngredientPurchaseSummary {
  ingredientId: string;
  ingredientSlug: string;
  ingredientName: string;
  category: string;
  unit: "g" | "ml" | "piece" | null;
  totalQuantity: number | null;
  lines: number;
  linesWithoutQuantity: number;
  minConfidence: number | null;
  lastPurchasedAt: string;
}

export interface PurchasedIngredientLine {
  receiptItemId: string;
  purchasedAt: string;
  productName: string;
  ingredientSlug: string;
  ingredientName: string;
  category: string;
  unit: "g" | "ml" | "piece" | null;
  quantity: number | null;
  quantitySource: string | null;
  quantityConfidence: number | null;
}

const toNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Synthèse par ingrédient des achats des `days` derniers jours (une ligne par ingrédient et par unité). */
export async function getIngredientPurchases(supabase: SupabaseClient, householdId: string, days = 14): Promise<IngredientPurchaseSummary[]> {
  const { data, error } = await supabase.rpc("ingredient_purchases", { p_household: householdId, p_days: days });
  if (error) throw new Error(`Lecture des ingrédients achetés impossible : ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ingredientId: r.ingredient_id as string,
    ingredientSlug: r.ingredient_slug as string,
    ingredientName: r.ingredient_name as string,
    category: r.category as string,
    unit: (r.unit as IngredientPurchaseSummary["unit"]) ?? null,
    totalQuantity: toNumber(r.total_quantity),
    lines: Number(r.lines),
    linesWithoutQuantity: Number(r.lines_without_quantity),
    minConfidence: toNumber(r.min_confidence),
    lastPurchasedAt: r.last_purchased_at as string,
  }));
}

/** Détail des ingrédients achetés depuis une date (ex. depuis la dernière synchronisation). */
export async function getPurchasedIngredientLines(supabase: SupabaseClient, householdId: string, since: Date): Promise<PurchasedIngredientLine[]> {
  const { data, error } = await supabase
    .from("purchased_ingredients")
    .select("receipt_item_id, purchased_at, product_name, ingredient_slug, ingredient_name, category, unit, quantity, quantity_source, quantity_confidence")
    .eq("household_id", householdId)
    .gte("purchased_at", since.toISOString())
    .order("purchased_at", { ascending: false });
  if (error) throw new Error(`Lecture des ingrédients achetés impossible : ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    receiptItemId: r.receipt_item_id as string,
    purchasedAt: r.purchased_at as string,
    productName: r.product_name as string,
    ingredientSlug: r.ingredient_slug as string,
    ingredientName: r.ingredient_name as string,
    category: r.category as string,
    unit: (r.unit as PurchasedIngredientLine["unit"]) ?? null,
    quantity: toNumber(r.quantity),
    quantitySource: (r.quantity_source as string) ?? null,
    quantityConfidence: toNumber(r.quantity_confidence),
  }));
}
