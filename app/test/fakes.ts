/** Faux serveur Lidl et fausse base Supabase pour tester la synchronisation sans réseau. */

import type { SupabaseClient } from "@supabase/supabase-js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** fetch simulé : chaque route est une fonction (url, init) -> Response. Les appels sont enregistrés. */
export function fakeFetch(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find(([rx]) => rx.test(url));
    if (!route) return new Response("not found", { status: 404 });
    return route[1](url, init);
  }) as typeof fetch;
  return { impl, calls };
}

/** Ticket imprimé minimal au format Lidl France. */
export function printedReceipt(lines: Array<{ art: string; text: string }>, payable: string): string {
  const spans = lines
    .map((l, i) => `<span id="purchase_list_line_${i + 2}" class="article" data-art-id="${l.art}" data-tax-type="A">${l.text}</span>`)
    .join("\n");
  return `<span class="purchase_list"><span id="purchase_list_line_1" class="currency" data-currency="EUR">Article</span>\n${spans}</span> A payer ${payable} `;
}

interface Call {
  table?: string;
  fn?: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, string, unknown]>;
}

/** Sous-ensemble de supabase-js : from().select/insert/update + eq/gte/order/single, et rpc(). */
export function fakeSupabase(state: { receipts: Array<{ household_id: string; source: string; external_id: string }>; rpcError?: (args: any) => string | null }) {
  const calls: Call[] = [];
  const runs: Array<Record<string, unknown>> = [];

  function builder(table: string) {
    const call: Call = { table, op: "select", filters: [] };
    const exec = () => {
      calls.push(call);
      if (table === "receipts" && call.op === "select") {
        const rows = state.receipts.filter((r) => call.filters.every(([, col, v]) => (r as any)[col] === v));
        return { data: rows.map((r) => ({ external_id: r.external_id })), error: null };
      }
      if (table === "sync_runs" && call.op === "insert") {
        const row = { id: `run-${runs.length + 1}`, ...(call.payload as object) };
        runs.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (table === "sync_runs" && call.op === "update") {
        const id = call.filters.find(([, col]) => col === "id")?.[2];
        const row = runs.find((r) => r.id === id);
        if (row) Object.assign(row, call.payload);
        return { data: null, error: null };
      }
      return { data: [], error: null };
    };
    const b: any = {
      select: () => b,
      insert: (payload: unknown) => ((call.op = "insert"), (call.payload = payload), b),
      update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), b),
      eq: (col: string, v: unknown) => (call.filters.push(["eq", col, v]), b),
      gte: (col: string, v: unknown) => (call.filters.push(["gte", col, v]), b),
      order: () => b,
      single: () => b,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(exec()).then(resolve, reject),
    };
    return b;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: any) => {
      calls.push({ fn, op: "rpc", payload: args, filters: [] });
      const message = state.rpcError?.(args) ?? null;
      if (message) return { data: null, error: { message } };
      if (fn === "import_receipt") {
        state.receipts.push({ household_id: args.p_household, source: "lidl_plus_fr", external_id: args.p.external_id });
        return { data: `receipt-${args.p.external_id}`, error: null };
      }
      return { data: [], error: null };
    },
  };
  return { client: client as unknown as SupabaseClient, calls, runs };
}
