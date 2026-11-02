/**
 * Lignes de la liste de courses : un même article demandé par plusieurs plats (des œufs pour la quiche et pour le poisson
 * pané) n'occupe qu'une ligne, quantités additionnées, avec les plats concernés. Cocher la ligne coche tous ses articles.
 */
import type { ShoppingItem } from "../modules/planning";
import { shoppingName } from "./format";

export interface ShoppingLine {
  key: string;
  name: string;
  /** Somme des quantités (null si l'une d'elles n'est pas chiffrée). */
  quantity: number | null;
  unit: string | null;
  items: ShoppingItem[];
  /** Plats concernés, sans doublon, dans l'ordre de la liste. */
  recipes: Array<{ id: string; name: string }>;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/œ/g, "oe").toLowerCase().trim()
  // Pluriel simple : « tomates » et « tomate » vont ensemble.
  .split(/\s+/).map((w) => (w.length > 3 ? w.replace(/[sx]$/, "") : w)).join(" ");

export function shoppingLines(items: ShoppingItem[]): ShoppingLine[] {
  const lines = new Map<string, ShoppingLine>();
  for (const i of items) {
    // Majuscule initiale pour tous (les recettes de Mistral en mettent, les autres non).
    const bare = shoppingName(i.label, i.quantity !== null);
    const name = bare.charAt(0).toUpperCase() + bare.slice(1);
    const key = `${fold(name)}|${i.unit ?? ""}`;
    const line = lines.get(key);
    if (!line) {
      lines.set(key, { key, name, quantity: i.quantity, unit: i.unit, items: [i], recipes: i.recipeId ? [{ id: i.recipeId, name: i.recipeName ?? "" }] : [] });
      continue;
    }
    line.items.push(i);
    line.quantity = line.quantity === null || i.quantity === null ? null : line.quantity + i.quantity;
    if (i.recipeId && !line.recipes.some((r) => r.id === i.recipeId)) line.recipes.push({ id: i.recipeId, name: i.recipeName ?? "" });
  }
  return [...lines.values()];
}
