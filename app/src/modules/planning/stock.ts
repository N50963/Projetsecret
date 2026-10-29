/**
 * Stock estimé d'après les tickets : chaque achat forme un lot, consommé par les repas servis ou choisis.
 * Les produits frais ne comptent que pendant leur durée de conservation (le foyer ne congèle pas viande et poisson).
 */

import type { IsoDate, PlannerIngredient, Purchase } from "./types";

/** Durée de conservation après achat, en jours, par catégorie d'ingrédient. */
export const SHELF_DAYS: Record<string, number> = {
  poisson: 2, viande: 3, volaille: 3, charcuterie: 10, oeuf: 21, produit_laitier: 10, fromage: 21, legume: 7, fruit: 7,
  herbe_epice: 5, pate_a_cuire: 10, feculent: 180, legumineuse: 365, conserve: 365, condiment: 180, matiere_grasse: 60,
  epicerie_sucree: 365, fruit_sec: 180,
};
/** Exceptions par ingrédient : conserves, poissons fumés, légumes de garde, produits souvent achetés surgelés. */
export const SHELF_DAYS_BY_INGREDIENT: Record<string, number> = {
  thon_conserve: 730, sardine_conserve: 730, anchois: 365, coeur_palmier: 730, mais: 365, ratatouille: 365, corned_beef: 730,
  truite_fumee: 14, thon_fume: 14, surimi: 14, canard_magret_fume: 21, saucisson: 60, rillettes_pate: 21, saucisse_cocktail: 30,
  poisson_blanc_pane: 90, legumes_melange: 90, petit_pois: 90, haricot_vert: 60, brocoli: 30,
  pomme_de_terre: 30, oignon: 30, oignon_rouge: 30, echalote: 30, ail: 60, carotte: 21, courge_butternut: 60, potimarron: 60,
  patate_douce: 21, betterave: 14, celeri_rave: 30, chou_blanc: 21, chou_rouge: 21, radis_noir: 21, topinambour: 14, salsifis: 14,
  gingembre: 21, champignon: 5, salade_verte: 5, mache: 4, roquette: 4, lait: 30, lait_vegetal: 30, lait_coco: 365,
};
const DEFAULT_SHELF_DAYS = 30;
const FROZEN_SHELF_DAYS = 60;
const FREEZABLE = new Set(["poisson", "viande", "volaille"]);
/** Une barquette de viande ou de poisson de contenance inconnue sert pour un seul repas. */
const SINGLE_USE = new Set(["poisson", "viande", "volaille"]);

/** Achats pris en compte pour le stock. */
export const PURCHASE_WINDOW_DAYS = 30;
/** Part du besoin à couvrir pour considérer un ingrédient comme disponible (les formats et les portions varient). */
export const AVAILABLE_RATIO = 0.5;
/** En dessous de cette part, la proposition signale une quantité un peu juste. */
export const TIGHT_RATIO = 0.8;
const SUBLINEAR_EXPONENT = 0.7;

const DAY_MS = 86_400_000;
const toUtc = (d: IsoDate) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

export function dayDiff(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return new Date(toUtc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function toIsoDate(d: Date): IsoDate {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Besoin d'un ingrédient pour le nombre de portions servi, dans l'unité de référence (null si non chiffrable). */
export function neededQuantity(ing: PlannerIngredient, recipeServings: number, servings: number): number | null {
  if (ing.baseQuantity === null) return null;
  const ratio = servings / recipeServings;
  if (ing.scale === "fixed") return ing.baseQuantity;
  return ing.baseQuantity * (ing.scale === "sublinear" ? Math.pow(ratio, SUBLINEAR_EXPONENT) : ratio);
}

interface Lot {
  remaining: number | null;
  unit: string | null;
  purchasedAt: IsoDate;
  expiresAt: IsoDate;
  usesLeft: number;
}

export interface Availability {
  present: boolean;
  /** Quantité restante connue (somme des lots chiffrés), null si seuls des lots de contenance inconnue restent. */
  quantity: number | null;
  /** Péremption la plus proche parmi les lots encore utilisables. */
  expiresAt: IsoDate | null;
  purchasedAt: IsoDate | null;
}

export class Stock {
  private constructor(private readonly lots: Map<string, Lot[]>) {}

  static fromPurchases(purchases: Purchase[], options: { freezes: boolean }): Stock {
    const lots = new Map<string, Lot[]>();
    for (const p of purchases) {
      const shelf = SHELF_DAYS_BY_INGREDIENT[p.slug]
        ?? (options.freezes && FREEZABLE.has(p.category) ? FROZEN_SHELF_DAYS : (SHELF_DAYS[p.category] ?? DEFAULT_SHELF_DAYS));
      const lot: Lot = {
        remaining: p.quantity, unit: p.unit, purchasedAt: p.purchasedAt, expiresAt: addDays(p.purchasedAt, shelf),
        usesLeft: p.quantity === null && SINGLE_USE.has(p.category) ? 1 : Number.POSITIVE_INFINITY,
      };
      const list = lots.get(p.slug) ?? [];
      list.push(lot);
      lots.set(p.slug, list);
    }
    for (const list of lots.values()) list.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    return new Stock(lots);
  }

  clone(): Stock {
    return new Stock(new Map([...this.lots].map(([k, v]) => [k, v.map((l) => ({ ...l }))])));
  }

  private usable(slug: string, date: IsoDate): Lot[] {
    return (this.lots.get(slug) ?? []).filter((l) => l.purchasedAt <= date && l.expiresAt >= date && l.usesLeft > 0
      && (l.remaining === null || l.remaining > 0));
  }

  available(slug: string, date: IsoDate): Availability {
    const lots = this.usable(slug, date);
    if (!lots.length) return { present: false, quantity: 0, expiresAt: null, purchasedAt: null };
    const known = lots.filter((l) => l.remaining !== null);
    const quantity = known.length === lots.length ? known.reduce((s, l) => s + (l.remaining ?? 0), 0) : null;
    return { present: true, quantity, expiresAt: lots[0]!.expiresAt, purchasedAt: lots[0]!.purchasedAt };
  }

  /** Consomme un besoin à une date, en commençant par les lots qui périment le plus tôt. */
  consume(slug: string, quantity: number | null, date: IsoDate): void {
    let left = quantity;
    for (const lot of this.usable(slug, date)) {
      if (lot.remaining === null) {
        lot.usesLeft -= 1;
        return;
      }
      if (left === null) return;
      const used = Math.min(lot.remaining, left);
      lot.remaining -= used;
      left -= used;
      if (left <= 0) return;
    }
  }
}
