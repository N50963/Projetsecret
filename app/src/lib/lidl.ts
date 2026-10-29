/** Lidl Plus sur le téléphone : jeton dans le stockage sécurisé, client, PKCE et synchronisation. */

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { base64Url, buildLoginUrl, createSecureTokenStore, exchangeCode, LidlClient, syncNewReceipts, type SyncResult } from "../modules/lidl-sync";
import { supabase } from "./supabase";

const memory = new Map<string, string>();
/** Sur le web (aperçu), pas de stockage sécurisé : le jeton reste en mémoire le temps de la page. */
const store = Platform.OS === "web"
  ? { getItemAsync: async (k: string) => memory.get(k) ?? null, setItemAsync: async (k: string, v: string) => void memory.set(k, v),
      deleteItemAsync: async (k: string) => void memory.delete(k) }
  : SecureStore;

export const lidlTokenStore = createSecureTokenStore(store);

export async function isLidlConnected(): Promise<boolean> {
  return Boolean(await lidlTokenStore.getRefreshToken());
}

export interface PkceLogin {
  url: string;
  verifier: string;
}

export async function startLidlLogin(): Promise<PkceLogin> {
  const verifier = base64Url(Crypto.getRandomBytes(48));
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(verifier));
  return { url: buildLoginUrl(base64Url(new Uint8Array(digest))), verifier };
}

export async function finishLidlLogin(code: string, verifier: string): Promise<void> {
  const tokens = await exchangeCode(code, verifier);
  await lidlTokenStore.setRefreshToken(tokens.refreshToken);
}

export async function syncLidl(householdId: string): Promise<SyncResult> {
  const lidl = new LidlClient({ tokenStore: lidlTokenStore });
  return syncNewReceipts({ lidl, supabase, householdId, maxPages: 4 });
}
