/**
 * Lecture du ticket imprimé (`htmlPrintedReceipt`) renvoyé par l'API Lidl Plus France.
 * Portage fidèle de services/lidl/lidl_parse.py : tous les montants sont en centimes (entiers),
 * le nom d'un article est pris dans le texte visible (l'attribut `data-art-description` est abîmé).
 */

import { decodeHtmlEntities } from "./htmlEntities";

export const PARSER_VERSION = 1;

export interface ReceiptItem {
  lineNo: number;
  artId: string;
  labelRaw: string;
  unitPriceCents: number | null;
  quantity: number | null;
  weightG: number | null;
  lineTotalCents: number;
  discountCents: number;
  discountLabels: string[];
  tax: string;
}

export interface ParseProblem {
  lineNo: number;
  reason: string;
  text: string;
}

const SPAN = /<span id="purchase_list_line_(\d+)" class="([^"]*)"([^>]*)>([\s\S]*?)<\/span>/g;
const ART = /^(.+?)\s+(-?\d+,\d{2})\s+x?\s*(\d+)\s+(-?\d+,\d{2})\s+([A-Z])(?:\s+T)?$/;
const WART = /^(.+?)\s+(-?\d+,\d{2})\s+([A-Z])(?:\s+T)?$/;
const WLINE = /^(\d+,\d+)\s*kg\s*x\s*(\d+,\d{2})\s*EUR\/kg$/;
const MONEY = /^-?\d+,\d{2}$/;
const ART_ID = /data-art-id="([^"]*)"/;

/** "1,17" -> 117, "-0,24" -> -24 (calcul exact, sans virgule flottante). */
export function cents(value: string): number {
  const negative = value.startsWith("-");
  const [intPart = "0", decPart = ""] = value.replace("-", "").split(",");
  const result = parseInt(intPart, 10) * 100 + parseInt((decPart + "00").slice(0, 2), 10);
  return negative ? -result : result;
}

/** "1,336" kg -> 1336 g, tronqué comme int(Decimal(...) * 1000) en Python. */
function grams(kg: string): number {
  const [intPart = "0", decPart = ""] = kg.split(",");
  return parseInt(intPart, 10) * 1000 + parseInt((decPart + "000").slice(0, 3), 10);
}

export function cleanText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

interface Line {
  classes: Set<string>;
  attrs: string;
  raw: string[];
}

function groupLines(html: string): Array<[number, Line]> {
  const lines = new Map<number, Line>();
  for (const m of html.matchAll(SPAN)) {
    const n = parseInt(m[1] as string, 10);
    let line = lines.get(n);
    if (!line) {
      line = { classes: new Set(), attrs: "", raw: [] };
      lines.set(n, line);
    }
    line.classes.add((m[2] as string).split(/\s+/)[0] as string);
    line.attrs += m[3] as string;
    line.raw.push(m[4] as string);
  }
  return [...lines.entries()].sort((a, b) => a[0] - b[0]);
}

interface MutableItem extends ReceiptItem {
  weighed: boolean;
}

export function parseReceipt(html: string): { items: ReceiptItem[]; problems: ParseProblem[] } {
  const items: MutableItem[] = [];
  const problems: ParseProblem[] = [];
  let last: MutableItem | null = null;

  for (const [n, line] of groupLines(html)) {
    const text = cleanText(line.raw.join(""));
    if (!text || line.classes.has("currency")) continue;
    const isArticle = line.classes.has("article");
    const weight = isArticle ? WLINE.exec(text) : null;

    if (weight) {
      if (last && last.weighed && last.weightG === null) {
        last.weightG = grams(weight[1] as string);
        last.unitPriceCents = cents(weight[2] as string);
        last.quantity = 1;
      } else {
        problems.push({ lineNo: n, reason: "ligne de pesée orpheline", text });
      }
    } else if (isArticle && line.attrs.includes("data-art-id")) {
      const artId = (ART_ID.exec(line.attrs) as RegExpExecArray)[1] as string;
      let m = ART.exec(text);
      if (m) {
        last = {
          lineNo: n, artId, labelRaw: (m[1] as string).trim(), unitPriceCents: cents(m[2] as string),
          quantity: parseInt(m[3] as string, 10), weightG: null, lineTotalCents: cents(m[4] as string),
          discountCents: 0, discountLabels: [], tax: m[5] as string, weighed: false,
        };
      } else {
        m = WART.exec(text);
        if (!m) {
          problems.push({ lineNo: n, reason: "ligne article illisible", text });
          last = null;
          continue;
        }
        last = {
          lineNo: n, artId, labelRaw: (m[1] as string).trim(), unitPriceCents: null, quantity: null, weightG: null,
          lineTotalCents: cents(m[2] as string), discountCents: 0, discountLabels: [], tax: m[3] as string, weighed: true,
        };
      }
      items.push(last);
    } else if (isArticle) {
      problems.push({ lineNo: n, reason: "ligne article sans id non reconnue", text });
    } else if (line.classes.has("discount") || line.classes.has("css_bold")) {
      const parts = line.raw.map(cleanText);
      const amounts = parts.filter((t) => MONEY.test(t));
      const label = parts.filter((t) => t && !MONEY.test(t)).join(" ");
      if (amounts.length === 0) continue;
      if (!last) {
        problems.push({ lineNo: n, reason: "remise sans article", text });
        continue;
      }
      last.discountCents += amounts.reduce((sum, a) => sum + cents(a), 0);
      last.discountLabels.push(label || "remise");
    }
  }
  return { items: items.map(({ weighed: _weighed, ...item }) => item), problems };
}

/** Montant « A payer » imprimé sur le ticket, en centimes. */
export function payableCents(html: string): number | null {
  const m = /A payer\s+(-?\d+,\d{2})/.exec(cleanText(html));
  return m ? cents(m[1] as string) : null;
}
