import { describe, expect, it } from "vitest";

import { adoptLegacyToken, createSecureTokenStore, tokenKeyFor, type SecureStoreLike } from "../src/modules/lidl-sync/tokenStore";

const OURS = "11111111-2222-3333-4444-555555555555";
const PARENTS = "66666666-7777-8888-9999-000000000000";

function memoryStore(initial: Record<string, string> = {}): SecureStoreLike & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItemAsync: async (k) => items.get(k) ?? null,
    setItemAsync: async (k, v) => void items.set(k, v),
    deleteItemAsync: async (k) => void items.delete(k),
  };
}

describe("jeton Lidl Plus par foyer", () => {
  it("chaque foyer a son propre jeton sur le même téléphone", async () => {
    const store = memoryStore();
    await createSecureTokenStore(store, OURS).setRefreshToken("rt-nous");
    await createSecureTokenStore(store, PARENTS).setRefreshToken("rt-parents");
    expect(await createSecureTokenStore(store, OURS).getRefreshToken()).toBe("rt-nous");
    expect(await createSecureTokenStore(store, PARENTS).getRefreshToken()).toBe("rt-parents");
    await createSecureTokenStore(store, PARENTS).clear();
    expect(await createSecureTokenStore(store, OURS).getRefreshToken()).toBe("rt-nous");
    expect(tokenKeyFor(OURS)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("le jeton d'avant la mise à jour revient au foyer qui a déjà récupéré des tickets, jamais à un autre", async () => {
    const store = memoryStore({ lidl_plus_refresh_token: "rt-ancien" });
    // Compte des parents ouvert sur ce téléphone : aucun ticket récupéré, le jeton n'est pas repris.
    expect(await adoptLegacyToken(store, PARENTS, async () => false)).toBe(false);
    expect(await createSecureTokenStore(store, PARENTS).getRefreshToken()).toBeNull();
    // Foyer d'origine : le jeton passe sous sa clé, l'ancienne clé disparaît.
    expect(await adoptLegacyToken(store, OURS, async () => true)).toBe(true);
    expect(await createSecureTokenStore(store, OURS).getRefreshToken()).toBe("rt-ancien");
    expect(store.items.has("lidl_plus_refresh_token")).toBe(false);
    expect(await adoptLegacyToken(store, PARENTS, async () => true)).toBe(false);
  });

  it("un foyer déjà connecté garde son jeton", async () => {
    const store = memoryStore({ lidl_plus_refresh_token: "rt-ancien", [tokenKeyFor(OURS)]: "rt-recent" });
    expect(await adoptLegacyToken(store, OURS, async () => true)).toBe(false);
    expect(await createSecureTokenStore(store, OURS).getRefreshToken()).toBe("rt-recent");
  });
});
