/**
 * Quantités des achats de fruits et légumes saisis à la main (écran « Fruits et légumes d'un autre magasin ») : paliers
 * du bouton +/−, quantité proposée au premier toucher, libellé. Fonctions pures (testées sans réseau).
 */

import { PACK_COUNT } from "../modules/planning/stock";

export type FreshCategory = "legume" | "fruit" | "herbe";

/** Fruit, légume ou herbe fraîche proposé à la saisie. */
export interface FreshProduct {
  id: string;
  slug: string;
  name: string;
  category: FreshCategory;
  /** Unité de référence de l'ingrédient (celle des recettes et du stock). */
  unit: "g" | "piece";
}

/** Produits vendus en botte : une botte compte pour son contenu habituel (comme sur un ticket). */
export const BUNCH: Record<string, number> = { radis: PACK_COUNT.radis ?? 15, oignon_nouveau: PACK_COUNT.oignon_nouveau ?? 5 };

/** Paliers de quantité proposés (en grammes) ; herbes fraîches : un bouquet fait environ 30 g. */
export const GRAM_STEPS = [100, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000];
export const HERB_STEPS = [10, 20, 30, 50, 100];

/** Quantité proposée au premier toucher. */
export function defaultQuantity(p: FreshProduct): number {
  if (p.category === "herbe") return 30;
  if (p.unit === "g") return ["ail", "gingembre", "echalote"].includes(p.slug) ? 100 : 500;
  return ({ avocat: 2, citron: 2, citron_vert: 2, kiwi: 4 } as Record<string, number>)[p.slug] ?? 1;
}

/** Quantité suivante (+1) ou précédente (-1) ; null quand on descend sous la plus petite (le produit est retiré). */
export function stepQuantity(p: FreshProduct, value: number, direction: 1 | -1): number | null {
  if (p.unit === "piece") {
    const next = value + direction;
    return next < 1 ? null : Math.min(next, 30);
  }
  const steps = p.category === "herbe" ? HERB_STEPS : GRAM_STEPS;
  if (direction > 0) return steps.find((s) => s > value) ?? steps[steps.length - 1]!;
  return [...steps].reverse().find((s) => s < value) ?? null;
}

/** Quantité lisible : « 500 g », « 1,5 kg », « 2 pièces », « 1 botte ». */
export function quantityLabel(slug: string, unit: "g" | "piece", quantity: number, fromStore = false): string {
  if (unit === "g") return quantity >= 1000 ? `${String(quantity / 1000).replace(".", ",")} kg` : `${quantity} g`;
  const bunch = BUNCH[slug];
  const n = bunch && fromStore ? Math.round(quantity / bunch) || 1 : quantity;
  if (bunch) return `${n} botte${n > 1 ? "s" : ""}`;
  return `${n} pièce${n > 1 ? "s" : ""}`;
}
