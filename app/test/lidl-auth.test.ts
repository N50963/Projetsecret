import { describe, expect, it } from "vitest";

import { base64Url, buildLoginUrl, exchangeCode, extractCode, isLidlCallback } from "../src/modules/lidl-sync/auth";

describe("connexion Lidl Plus dans l'application (OAuth2 + PKCE)", () => {
  it("encode en base64 « URL » sans remplissage, comme Node", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 48]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);
      expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("construit l'adresse de connexion Lidl avec le défi PKCE, le pays et la langue", () => {
    const url = new URL(buildLoginUrl("defi-123"));
    expect(url.origin + url.pathname).toBe("https://accounts.lidl.com/connect/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "LidlPlusNativeClient", response_type: "code", redirect_uri: "com.lidlplus.app://callback",
      code_challenge: "defi-123", code_challenge_method: "S256", Country: "FR", language: "fr-FR",
      scope: "openid profile offline_access lpprofile lpapis",
    });
  });

  it("reconnaît le retour de Lidl et en extrait le code", () => {
    expect(isLidlCallback("com.lidlplus.app://callback?code=ABC&scope=openid")).toBe(true);
    expect(isLidlCallback("https://accounts.lidl.com/Account/Login")).toBe(false);
    expect(extractCode("com.lidlplus.app://callback?code=ABC%2F1&state=x")).toBe("ABC/1");
    expect(extractCode("com.lidlplus.app://callback#code=XYZ")).toBe("XYZ");
    expect(extractCode("com.lidlplus.app://callback?error=access_denied")).toBeNull();
  });

  it("échange le code contre les jetons et refuse une réponse incomplète", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ refresh_token: "R", access_token: "A", expires_in: 1200 }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(exchangeCode("CODE", "VERIF", ok)).resolves.toEqual({ refreshToken: "R", accessToken: "A", expiresIn: 1200 });
    expect(calls[0]!.url).toBe("https://accounts.lidl.com/connect/token");
    expect(String(calls[0]!.init.body)).toContain("code_verifier=VERIF");
    const empty = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeCode("CODE", "VERIF", empty)).rejects.toThrow(/incomplète/);
    const refused = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeCode("CODE", "VERIF", refused)).rejects.toThrow(/refusé/);
  });
});
