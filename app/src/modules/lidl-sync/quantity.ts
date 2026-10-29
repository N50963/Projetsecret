/**
 * Contenance lue dans un libellé (portage de services/catalog/quantity.py).
 * Unités de base : g, ml ou piece. Le poids ou le volume l'emporte sur un nombre de pièces.
 * Aucune conversion masse/volume. Écrit sans « lookbehind » pour rester compatible avec tous les moteurs JS mobiles.
 */

export type PackUnit = "g" | "ml" | "piece";
export interface PackQuantity {
  value: number;
  unit: PackUnit;
}

const UNITS: Record<string, [PackUnit, number]> = {
  kg: ["g", 1000], g: ["g", 1], gr: ["g", 1], grammes: ["g", 1],
  l: ["ml", 1000], litre: ["ml", 1000], litres: ["ml", 1000], cl: ["ml", 10], ml: ["ml", 1],
};
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT_RX = "(kg|grammes|gr|g|litres|litre|l|cl|ml)";
const MULTI = new RegExp(String.raw`(\d+)\s*x\s*` + NUM + String.raw`\s*` + UNIT_RX + "(?![a-z])");
const SIMPLE = new RegExp(NUM + String.raw`\s*` + UNIT_RX + "(?![a-z])");
const PIECES_SUM = /(\d+)\s*\+\s*(\d+)\s*t(?![a-z])/;
const PIECE_WORDS = "(tranches|tranche|t|pots|pot|oeufs|rouleaux|portions|fruits|pieces|pcs|batonnets|tetes|fruit)";
const PIECES_WORD = new RegExp(String.raw`(\d+)\s*` + PIECE_WORDS + "(?![a-z])", "g");
const PIECES_X = /(?:^|\s)[x*]\s*(\d+)(?![\d,.])/;
const PIECES_NXM = /(\d+)\s*x\s*\d+(?:\s*cm)?(?![\d,.a-z])/g;
const PIECES_LEAD = /^(\d+)\s+[a-z]/;

function clean(text: string): string {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const num = (s: string) => parseFloat(s.replace(",", "."));
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Première correspondance dont le nombre n'est pas précédé d'un chiffre, d'une virgule ou d'un point. */
function firstNotAfterNumber(rx: RegExp, text: string): RegExpExecArray | null {
  rx.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    const before = m.index > 0 ? text[m.index - 1] : "";
    if (!before || !/[\d,.]/.test(before)) return m;
    rx.lastIndex = m.index + 1;
  }
  return null;
}

export function parseQuantity(text: string): PackQuantity | null {
  const t = clean(text);
  if (!t) return null;
  let m = MULTI.exec(t);
  if (m) {
    const [unit, factor] = UNITS[m[3] as string] as [PackUnit, number];
    return { value: round1(parseInt(m[1] as string, 10) * num(m[2] as string) * factor), unit };
  }
  m = SIMPLE.exec(t);
  if (m) {
    const [unit, factor] = UNITS[m[2] as string] as [PackUnit, number];
    const value = round1(num(m[1] as string) * factor);
    if (value > 0) return { value, unit };
  }
  m = PIECES_SUM.exec(t);
  if (m) return { value: parseInt(m[1] as string, 10) + parseInt(m[2] as string, 10), unit: "piece" };
  const candidates = [firstNotAfterNumber(PIECES_WORD, t), PIECES_X.exec(t), firstNotAfterNumber(PIECES_NXM, t), PIECES_LEAD.exec(t)];
  for (const c of candidates) {
    if (c) {
      const n = parseInt(c[1] as string, 10);
      if (n > 0 && n <= 100) return { value: n, unit: "piece" };
    }
  }
  return null;
}
