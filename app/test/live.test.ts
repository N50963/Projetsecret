/**
 * Essai réel contre Lidl Plus France (aucune écriture en base). Ne s'exécute que si LIDL_LIVE_TOKEN_FILE pointe
 * vers un fichier contenant un refresh token ; un token renouvelé par Lidl y est réécrit. Le token n'est jamais affiché.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { LidlClient } from "../src/modules/lidl-sync/lidlClient";
import { buildReceiptPayload } from "../src/modules/lidl-sync/payload";
import type { TokenStore } from "../src/modules/lidl-sync/tokenStore";

const file = process.env.LIDL_LIVE_TOKEN_FILE;

describe.skipIf(!file || !existsSync(file))("Lidl Plus France (réel)", () => {
  it("liste les tickets, lit le plus récent et retrouve son total au centime", async () => {
    const store: TokenStore = {
      getRefreshToken: async () => readFileSync(file as string, "utf8").trim(),
      setRefreshToken: async (t) => writeFileSync(file as string, `${t}\n`, { mode: 0o600 }),
      clear: async () => {},
    };
    const client = new LidlClient({ tokenStore: store });
    const page = await client.listTickets(1);
    expect(page.totalCount).toBeGreaterThan(0);
    const latest = page.tickets[0];
    expect(latest).toBeDefined();
    const built = buildReceiptPayload(await client.getTicket(latest!.id), latest);
    expect(built.items.length).toBeGreaterThan(0);
    expect(built.reconciled).toBe(true);
    console.log(`tickets: ${page.totalCount}, dernier: ${latest!.date.slice(0, 10)}, lignes: ${built.items.length}, total: ${built.payload.total_cents} centimes`);
  }, 60_000);
});
