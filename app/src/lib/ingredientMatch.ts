/**
 * Rattachement d'un ingrédient saisi dans une recette (« 2 courgettes », « lardons fumés ») à un ingrédient du
 * référentiel : c'est lui qui donne la photo sur la fiche, la comparaison avec les achats, le panier « à acheter » et
 * le stock des propositions. Fonctions pures (testées sans réseau).
 */

import type { RecipeUnit } from "../modules/recipes";

/** Ingrédient du référentiel. */
export interface ReferenceIngredient {
  slug: string;
  name: string;
  /** Unité de référence (celle des achats et du stock). */
  default_unit?: "g" | "ml" | "piece" | string | null;
}

export const fold = (s: string) =>
  s.replace(/[œŒ]/g, "oe").replace(/[æÆ]/g, "ae").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Mots sans intérêt pour reconnaître un ingrédient (quantités, unités, articles, contenants). */
const NOISE = new Set([
  "g", "kg", "gr", "grammes", "gramme", "ml", "cl", "l", "litre", "litres", "c", "cs", "cc", "cuillere", "cuilleres", "soupe", "cafe",
  "pincee", "pincees", "de", "d", "du", "des", "la", "le", "les", "l", "un", "une", "et", "ou", "a", "au", "aux", "en", "pour",
  "gousse", "gousses", "tranche", "tranches", "boite", "boites", "botte", "bottes", "sachet", "sachets", "brin", "brins", "feuille",
  "feuilles", "morceau", "morceaux", "filet", "petit", "petits", "petite", "petites", "gros", "grosse", "grosses", "bel", "belle",
  "belles", "beau", "beaux", "frais", "fraiche", "fraiches", "facultatif", "environ", "bien", "tres",
]);

/** Mot au singulier, sans accents (« courgettes » → « courgette », « choux » → « chou »). */
function singular(w: string): string {
  if (w.length > 3 && w.endsWith("aux")) return `${w.slice(0, -3)}al`;
  if (w.length > 3 && (w.endsWith("s") || w.endsWith("x"))) return w.slice(0, -1);
  return w;
}

const words = (s: string) => fold(s).replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean).map(singular);

/**
 * Façons de nommer un ingrédient du référentiel : son nom entier et chacune de ses variantes
 * (« Poisson blanc (cabillaud, lieu, colin...) » → poisson blanc, cabillaud, lieu, colin).
 */
function keysOf(name: string): string[][] {
  const parts = name.replace(/\.\.\./g, "").split(/[(),/]/).map((p) => words(p).filter((w) => !NOISE.has(w))).filter((p) => p.length);
  const whole = words(name.replace(/\(.*?\)/g, "")).filter((w) => !NOISE.has(w));
  return [whole, ...parts].filter((k, i, all) => k.length && all.findIndex((x) => x.join(" ") === k.join(" ")) === i);
}

/** Le libellé contient-il cette suite de mots (dans l'ordre, côte à côte) ? */
function contains(label: string[], key: string[]): boolean {
  for (let i = 0; i + key.length <= label.length; i++) {
    if (key.every((w, k) => label[i + k] === w)) return true;
  }
  return false;
}

/** Ingrédient reconnu dans un libellé : `strong` quand son nom (ou une variante) y figure en entier. */
interface Match {
  o: ReferenceIngredient;
  score: number;
  strong: boolean;
}

function rank(label: string, options: ReferenceIngredient[]): Match[] {
  const lw = words(label).filter((w) => !NOISE.has(w));
  if (!lw.length) return [];
  const out: Match[] = [];
  for (const o of options) {
    let score = 0;
    let strong = false;
    for (const key of keysOf(o.name)) {
      if (contains(lw, key)) {
        const s = key.join(" ").length + (key.length > 1 ? 2 : 0);
        if (s > score) {
          score = s;
          strong = true;
        }
      }
    }
    // Sinon, un mot significatif du nom (« crème » pour « Crème fraîche épaisse ») : simple suggestion.
    if (!strong) {
      for (const w of new Set(keysOf(o.name).flat())) if (w.length >= 4 && lw.includes(w)) score = Math.max(score, w.length / 2);
    }
    if (score >= 2) out.push({ o, score, strong });
  }
  return out.sort((a, b) => b.score - a.score || a.o.name.localeCompare(b.o.name, "fr"));
}

/**
 * Ingrédients du référentiel reconnus dans un libellé, le plus précis d'abord (« pommes de terre » avant « pomme »).
 * Vide si rien n'est reconnu.
 */
export function suggestIngredients(label: string, options: ReferenceIngredient[], max = 3): ReferenceIngredient[] {
  return rank(label, options).slice(0, max).map((m) => m.o);
}

/**
 * Ingrédient à relier sans rien demander : reconnu en entier dans le libellé, et sans autre candidat aussi précis.
 * null quand c'est ambigu (« crème » : épaisse ou liquide ?) ; le foyer choisit alors parmi les suggestions.
 */
export function autoLink(label: string, options: ReferenceIngredient[]): ReferenceIngredient | null {
  const [first, second] = rank(label, options);
  if (!first?.strong) return null;
  return second && second.score >= first.score ? null : first.o;
}

/** Recherche dans le référentiel : les noms qui commencent par le texte d'abord. */
export function searchIngredients(query: string, options: ReferenceIngredient[], max = 8): ReferenceIngredient[] {
  const q = fold(query.trim());
  if (!q) return [];
  const hits = options.filter((o) => fold(o.name).includes(q));
  return hits.sort((a, b) => Number(!fold(b.name).startsWith(q)) - Number(!fold(a.name).startsWith(q)) || a.name.localeCompare(b.name, "fr")).slice(0, max);
}

const SPOON_ML: Partial<Record<RecipeUnit, number>> = { cs: 15, cc: 5 };

/**
 * Quantité de référence (comparée aux achats) d'un ingrédient relié : même unité que le référentiel, ou cuillères pour
 * un ingrédient en millilitres. Sinon rien (l'ingrédient s'affiche, sans comparaison de quantité).
 */
export function baseQuantity(unit: RecipeUnit | null, quantity: number | null, defaultUnit: string | null | undefined):
  { base_quantity: number | null; base_unit: string | null } {
  if (unit === null || quantity === null || !defaultUnit) return { base_quantity: null, base_unit: null };
  if (unit === defaultUnit) return { base_quantity: quantity, base_unit: unit };
  const ml = SPOON_ML[unit];
  if (defaultUnit === "ml" && ml) return { base_quantity: quantity * ml, base_unit: "ml" };
  return { base_quantity: null, base_unit: null };
}

const UNIT_WORDS: Array<[RegExp, RecipeUnit, number]> = [
  [/^(kg|kilos?|kilogrammes?)$/, "g", 1000], [/^(g|gr|grammes?)$/, "g", 1], [/^(l|litres?)$/, "ml", 1000], [/^cl$/, "ml", 10],
  [/^ml$/, "ml", 1], [/^(cs|c\.?\s*a\s*s\.?|cuilleres?\s+a\s+soupe)$/, "cs", 1], [/^(cc|c\.?\s*a\s*c\.?|cuilleres?\s+a\s+cafe)$/, "cc", 1],
  [/^pincees?$/, "pincee", 1],
];

/**
 * Quantité tapée au début d'un libellé (« 200 g de lardons », « 2 courgettes », « 1 cuillère à soupe d'huile ») :
 * rangée dans les cases quantité et unité, le libellé ne gardant que l'ingrédient. null si le libellé ne commence pas
 * par un nombre.
 */
export function parseQuantity(label: string): { quantity: number; unit: RecipeUnit; label: string } | null {
  const m = label.trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return null;
  const quantity = Number(m[1]!.replace(",", "."));
  if (!(quantity > 0)) return null;
  let rest = m[2]!.trim();
  const folded = fold(rest);
  for (const [pattern, unit, factor] of UNIT_WORDS) {
    // L'unité la plus longue possible en tête du reste (« cuillères à soupe » avant « c »).
    for (let n = Math.min(4, folded.split(/\s+/).length); n >= 1; n--) {
      const head = folded.split(/\s+/).slice(0, n).join(" ");
      if (pattern.test(head)) {
        rest = rest.split(/\s+/).slice(n).join(" ").replace(/^(de\s+|d['’]\s*)/i, "").trim();
        return rest ? { quantity: quantity * factor, unit, label: rest } : null;
      }
    }
  }
  return rest ? { quantity, unit: "piece", label: rest.replace(/^(de\s+|d['’]\s*)/i, "") } : null;
}
