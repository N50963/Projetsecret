/** Construction du ticket envoyé à la fonction Supabase `import_receipt` (même format que l'import initial). */

import { LidlSyncError } from "./errors";
import type { TicketDetail, TicketSummary } from "./lidlClient";
import { parseQuantity } from "./quantity";
import { PARSER_VERSION, parseReceipt, payableCents, type ReceiptItem } from "./receiptParser";

export interface ReceiptPayload {
  external_id: string;
  purchased_at: string;
  total_cents: number;
  articles_count: number | null;
  parser_version: number;
  store: { id: string | null; name: string | null; locality: string | null; postal_code: string | null };
  detail: TicketDetail;
  items: Array<{
    line_no: number;
    art_id: string;
    label_raw: string;
    quantity: number | null;
    weight_g: number | null;
    unit_price_cents: number | null;
    line_total_cents: number;
    discount_cents: number;
    tax: string;
    discount_labels: string[];
    pack_quantity: number | null;
    pack_unit: string | null;
  }>;
}

export interface BuiltReceipt {
  payload: ReceiptPayload;
  items: ReceiptItem[];
  /** Somme des lignes et remises égale au total du ticket (contrôle au centime). */
  reconciled: boolean;
}

export function buildReceiptPayload(detail: TicketDetail, summary?: TicketSummary): BuiltReceipt {
  const html = detail.htmlPrintedReceipt;
  if (!html) throw new LidlSyncError("parse_failed", `Ticket ${detail.id} sans ticket imprimé.`);
  const { items, problems } = parseReceipt(html);
  if (problems.length > 0) {
    const first = problems[0] as { reason: string };
    throw new LidlSyncError("parse_failed", `Ticket ${detail.id} : ${problems.length} ligne(s) illisible(s) (${first.reason}).`);
  }
  const totalCents = Math.round(detail.totalAmount * 100);
  const sum = items.reduce((s, i) => s + i.lineTotalCents + i.discountCents, 0);
  const store = detail.store ?? {};
  return {
    items,
    reconciled: sum === totalCents && payableCents(html) === totalCents,
    payload: {
      external_id: detail.id,
      purchased_at: detail.date,
      total_cents: totalCents,
      articles_count: typeof summary?.articlesCount === "number" ? summary.articlesCount : null,
      parser_version: PARSER_VERSION,
      store: {
        id: (store.id as string | undefined) ?? null,
        name: (store.name as string | undefined) ?? null,
        locality: (store.locality as string | undefined) ?? null,
        postal_code: (store.postalCode as string | undefined) ?? null,
      },
      detail,
      items: items.map((i) => {
        const pack = i.weightG === null ? parseQuantity(i.labelRaw) : null;
        return {
          line_no: i.lineNo,
          art_id: i.artId,
          label_raw: i.labelRaw,
          quantity: i.quantity,
          weight_g: i.weightG,
          unit_price_cents: i.unitPriceCents,
          line_total_cents: i.lineTotalCents,
          discount_cents: i.discountCents,
          tax: i.tax,
          discount_labels: i.discountLabels,
          pack_quantity: pack?.value ?? null,
          pack_unit: pack?.unit ?? null,
        };
      }),
    },
  };
}
