import { describe, expect, it } from "vitest";

import { errorText, isNetworkError } from "../src/lib/errors";

describe("messages d'erreur", () => {
  it("traduit une coupure de réseau Android en message clair, avec l'action concernée", () => {
    const e = new Error('Refus non enregistré : Error: fetch failed: java.net.UnknownHostException: Unable to resolve host "x.supabase.co": No address associated with hostname');
    expect(isNetworkError(e)).toBe(true);
    expect(errorText(e)).toBe("Refus non enregistré : pas de connexion Internet. Vérifiez le Wi-Fi ou les données mobiles, puis réessayez.");
    expect(errorText(new TypeError("Network request failed"))).toBe("Pas de connexion Internet. Vérifiez le Wi-Fi ou les données mobiles, puis réessayez.");
  });

  it("retire les préfixes techniques des autres erreurs", () => {
    expect(errorText(new Error("Avis non enregistré : Error: duplicate key"))).toBe("Avis non enregistré : duplicate key");
    expect(errorText("Error: Foyer inaccessible")).toBe("Foyer inaccessible");
    expect(isNetworkError(new Error("Foyer inaccessible"))).toBe(false);
  });
});
