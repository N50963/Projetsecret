/**
 * Connexion Lidl Plus faite par la personne elle-même dans une page de connexion Lidl (OAuth2 avec PKCE) :
 * l'application ouvre la page, récupère le code au retour (com.lidlplus.app://callback?code=...) et l'échange contre
 * le refresh token, conservé dans le stockage sécurisé du téléphone. Aucun mot de passe ne passe par l'application.
 */

import { LidlSyncError } from "./errors";

export const LIDL_AUTH_API = "https://accounts.lidl.com";
export const LIDL_CLIENT_ID = "LidlPlusNativeClient";
export const LIDL_REDIRECT_URI = "com.lidlplus.app://callback";
export const LIDL_SCOPE = "openid profile offline_access lpprofile lpapis";
const BASIC_AUTH = "TGlkbFBsdXNOYXRpdmVDbGllbnQ6c2VjcmV0";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64 « URL » sans remplissage (RFC 4648 §5), sans dépendre de Buffer ni de btoa. */
export function base64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}

/** Adresse de la page de connexion Lidl ; `challenge` = base64Url(SHA-256(verifier)). */
export function buildLoginUrl(challenge: string, country = "FR", language = "fr"): string {
  const params = new URLSearchParams({
    client_id: LIDL_CLIENT_ID, response_type: "code", scope: LIDL_SCOPE, redirect_uri: LIDL_REDIRECT_URI,
    code_challenge: challenge, code_challenge_method: "S256", Country: country.toUpperCase(),
    language: `${language.toLowerCase()}-${country.toUpperCase()}`,
  });
  return `${LIDL_AUTH_API}/connect/authorize?${params.toString()}`;
}

export function isLidlCallback(url: string): boolean {
  return url.toLowerCase().startsWith(LIDL_REDIRECT_URI.split("?")[0]!.toLowerCase());
}

/** Code d'autorisation contenu dans l'adresse de retour, ou null. */
export function extractCode(url: string): string | null {
  const query = url.split("?")[1]?.split("#")[0] ?? "";
  const fragment = url.split("#")[1] ?? "";
  for (const part of [query, fragment]) {
    const code = new URLSearchParams(part).get("code");
    if (code) return code;
  }
  return null;
}

export interface LidlTokens {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
}

export async function exchangeCode(code: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<LidlTokens> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: LIDL_REDIRECT_URI, code_verifier: verifier });
  const response = await fetchImpl(`${LIDL_AUTH_API}/connect/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${BASIC_AUTH}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new LidlSyncError("lidl_rejected", `Lidl a refusé la connexion (${response.status}).`);
  const data = (await response.json()) as { refresh_token?: string; access_token?: string; expires_in?: number };
  if (!data.refresh_token || !data.access_token) throw new LidlSyncError("lidl_rejected", "Réponse de Lidl incomplète (jeton absent).");
  return { refreshToken: data.refresh_token, accessToken: data.access_token, expiresIn: data.expires_in ?? 0 };
}
