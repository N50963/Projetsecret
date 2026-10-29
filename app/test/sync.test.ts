import { describe, expect, it } from "vitest";

import { LidlClient, LIDL_BASIC_AUTH } from "../src/modules/lidl-sync/lidlClient";
import { ReauthRequiredError } from "../src/modules/lidl-sync/errors";
import { buildReceiptPayload } from "../src/modules/lidl-sync/payload";
import { syncNewReceipts } from "../src/modules/lidl-sync/sync";
import { MemoryTokenStore } from "../src/modules/lidl-sync/tokenStore";
import { fakeFetch, fakeSupabase, json, printedReceipt } from "./fakes";

const HOUSEHOLD = "foyer-1";
const noSleep = async () => {};

function ticket(id: string, date: string, euros: string, label = "Courgette") {
  const total = euros.replace(".", ",");
  return {
    id, date, totalAmount: Number(euros),
    store: { id: "S1", name: "Magasin", locality: "Ville", postalCode: "00000" },
    htmlPrintedReceipt: printedReceipt([{ art: "0001", text: `${label} 500 g ${total} 1 ${total} A` }], total),
  };
}

/** Faux Lidl : 2 pages de tickets (les plus récents d'abord). */
function lidlServer(opts: { refresh?: (body: string) => Response; tickets?: ReturnType<typeof ticket>[]; v3Status?: number } = {}) {
  const tickets = opts.tickets ?? [ticket("T3", "2026-10-29T10:00:00", "3.00"), ticket("T2", "2026-10-20T10:00:00", "2.00"), ticket("T1", "2026-10-10T10:00:00", "1.00")];
  const pages = [tickets.slice(0, 2), tickets.slice(2)];
  return fakeFetch([
    [/accounts\.lidl\.com\/connect\/token/, (_url, init) => opts.refresh?.(String(init.body)) ?? json({ access_token: "acc", expires_in: 1200, refresh_token: "rt-2" })],
    [/api\/v2\/FR\/tickets\?pageNumber=(\d+)/, (url) => {
      const page = Number(/pageNumber=(\d+)/.exec(url)?.[1]);
      return json({ page, size: 2, totalCount: tickets.length, tickets: (pages[page - 1] ?? []).map(({ id, date, totalAmount }) => ({ id, date, totalAmount, articlesCount: 1 })) });
    }],
    [/api\/v3\/FR\/tickets\/(\w+)/, (url) => {
      if (opts.v3Status) return new Response("", { status: opts.v3Status });
      const id = /tickets\/(\w+)/.exec(url)?.[1];
      return json(tickets.find((t) => t.id === id));
    }],
    [/api\/v2\/FR\/tickets\/(\w+)/, (url) => json(tickets.find((t) => t.id === /tickets\/(\w+)/.exec(url)?.[1]))],
  ]);
}

describe("LidlClient", () => {
  it("renouvelle le jeton avec l'identifiant de l'application et enregistre le nouveau refresh token", async () => {
    expect(Buffer.from(LIDL_BASIC_AUTH, "base64").toString()).toBe("LidlPlusNativeClient:secret");
    const store = new MemoryTokenStore("rt-1");
    const server = lidlServer();
    const client = new LidlClient({ tokenStore: store, fetchImpl: server.impl, sleep: noSleep });
    await client.listTickets(1);
    const auth = server.calls[0];
    expect(auth?.init.body).toBe("grant_type=refresh_token&refresh_token=rt-1");
    expect((auth?.init.headers as Record<string, string>).Authorization).toBe(`Basic ${LIDL_BASIC_AUTH}`);
    expect(await store.getRefreshToken()).toBe("rt-2");
  });

  it("demande une reconnexion quand Lidl refuse le refresh token", async () => {
    const server = lidlServer({ refresh: () => json({ error: "invalid_grant" }, 400) });
    const client = new LidlClient({ tokenStore: new MemoryTokenStore("expiré"), fetchImpl: server.impl, sleep: noSleep });
    await expect(client.listTickets(1)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("réessaie quand Lidl est momentanément indisponible", async () => {
    let n = 0;
    const server = lidlServer({ refresh: () => (++n < 3 ? new Response("", { status: 503 }) : json({ access_token: "a", expires_in: 1200 })) });
    const client = new LidlClient({ tokenStore: new MemoryTokenStore("rt"), fetchImpl: server.impl, sleep: noSleep });
    await client.listTickets(1);
    expect(n).toBe(3);
  });

  it("lit le détail en v3 puis se replie sur la v2", async () => {
    const server = lidlServer({ v3Status: 400 });
    const client = new LidlClient({ tokenStore: new MemoryTokenStore("rt"), fetchImpl: server.impl, sleep: noSleep });
    expect((await client.getTicket("T1")).id).toBe("T1");
    expect(server.calls.map((c) => c.url).filter((u) => u.includes("/tickets/T1"))).toEqual([
      "https://tickets.lidlplus.com/api/v3/FR/tickets/T1", "https://tickets.lidlplus.com/api/v2/FR/tickets/T1",
    ]);
  });
});

describe("buildReceiptPayload", () => {
  it("ajoute la contenance lue dans le libellé et vérifie le total", () => {
    const built = buildReceiptPayload(ticket("T9", "2026-10-29T10:00:00", "2.49", "Courgette"));
    expect(built.reconciled).toBe(true);
    expect(built.payload.items[0]).toMatchObject({ label_raw: "Courgette 500 g", pack_quantity: 500, pack_unit: "g", line_total_cents: 249 });
  });
});

describe("syncNewReceipts", () => {
  it("n'importe que les nouveaux tickets, du plus ancien au plus récent, et trace l'exécution", async () => {
    const db = fakeSupabase({ receipts: [{ household_id: HOUSEHOLD, source: "lidl_plus_fr", external_id: "T1" }] });
    const server = lidlServer();
    const lidl = new LidlClient({ tokenStore: new MemoryTokenStore("rt"), fetchImpl: server.impl, sleep: noSleep });
    const result = await syncNewReceipts({ lidl, supabase: db.client, householdId: HOUSEHOLD });
    expect(result).toMatchObject({ status: "success", newReceipts: 2, importedIds: ["T2", "T3"], failures: [] });
    expect(db.runs[0]).toMatchObject({ status: "success", new_receipts: 2, failed_receipts: 0 });
    // Une seconde synchronisation ne trouve rien de nouveau et s'arrête dès la première page.
    const again = await syncNewReceipts({ lidl, supabase: db.client, householdId: HOUSEHOLD });
    expect(again).toMatchObject({ status: "success", newReceipts: 0 });
  });

  it("continue après un ticket refusé et signale un résultat partiel", async () => {
    const db = fakeSupabase({ receipts: [], rpcError: (args) => (args.p.external_id === "T2" ? "refus simulé" : null) });
    const server = lidlServer();
    const lidl = new LidlClient({ tokenStore: new MemoryTokenStore("rt"), fetchImpl: server.impl, sleep: noSleep });
    const result = await syncNewReceipts({ lidl, supabase: db.client, householdId: HOUSEHOLD });
    expect(result.status).toBe("partial");
    expect(result.importedIds).toEqual(["T1", "T3"]);
    expect(result.failures).toEqual([{ ticketId: "T2", code: "import_failed", message: "Enregistrement refusé : refus simulé" }]);
  });

  it("indique qu'une reconnexion est nécessaire, sans jamais journaliser le jeton", async () => {
    const db = fakeSupabase({ receipts: [] });
    const server = lidlServer({ refresh: () => json({ error: "invalid_grant" }, 400) });
    const lidl = new LidlClient({ tokenStore: new MemoryTokenStore("secret-token-xyz"), fetchImpl: server.impl, sleep: noSleep });
    const result = await syncNewReceipts({ lidl, supabase: db.client, householdId: HOUSEHOLD });
    expect(result.status).toBe("reauth_required");
    expect(JSON.stringify(db.runs)).not.toContain("secret-token-xyz");
    expect(db.runs[0]).toMatchObject({ status: "reauth_required", error_code: "reauth_required" });
  });

  it("ne lance qu'une synchronisation à la fois sur l'appareil", async () => {
    const db = fakeSupabase({ receipts: [] });
    const server = lidlServer();
    const lidl = new LidlClient({ tokenStore: new MemoryTokenStore("rt"), fetchImpl: server.impl, sleep: noSleep });
    const [a, b] = await Promise.all([
      syncNewReceipts({ lidl, supabase: db.client, householdId: HOUSEHOLD }),
      syncNewReceipts({ lidl, supabase: db.client, householdId: HOUSEHOLD }),
    ]);
    expect(a).toBe(b);
    expect(db.runs).toHaveLength(1);
  });
});
