/**
 * Lidl Plus sur le téléphone : jeton dans le stockage sécurisé (un par foyer : chaque foyer a son compte Lidl Plus),
 * client, PKCE et synchronisation.
 */

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import {
  adoptLegacyToken, base64Url, buildLoginUrl, createSecureTokenStore, exchangeCode, LidlClient, syncNewReceipts, type SyncResult,
} from "../modules/lidl-sync";
import { supabase } from "./supabase";

const memory = new Map<string, string>();
/** Sur le web (aperçu), pas de stockage sécurisé : le jeton reste en mémoire le temps de la page. */
const store = Platform.OS === "web"
  ? { getItemAsync: async (k: string) => memory.get(k) ?? null, setItemAsync: async (k: string, v: string) => void memory.set(k, v),
      deleteItemAsync: async (k: string) => void memory.delete(k) }
  : SecureStore;

/**
 * Jeton Lidl Plus du foyer. Celui d'une version précédente (clé unique) revient au foyer qui a déjà récupéré des
 * tickets avec ce compte ; un autre foyer (les parents) se connecte avec son propre compte Lidl Plus.
 */
async function tokenStoreFor(householdId: string) {
  await adoptLegacyToken(store, householdId, async () => {
    const { count, error } = await supabase.from("sync_runs").select("id", { count: "exact", head: true })
      .eq("household_id", householdId).eq("status", "success");
    return !error && (count ?? 0) > 0;
  }).catch(() => false);
  return createSecureTokenStore(store, householdId);
}

export async function isLidlConnected(householdId: string): Promise<boolean> {
  return Boolean(await (await tokenStoreFor(householdId)).getRefreshToken());
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

export async function finishLidlLogin(code: string, verifier: string, householdId: string): Promise<void> {
  const tokens = await exchangeCode(code, verifier);
  await (await tokenStoreFor(householdId)).setRefreshToken(tokens.refreshToken);
}

export async function syncLidl(householdId: string): Promise<SyncResult> {
  const lidl = new LidlClient({ tokenStore: await tokenStoreFor(householdId) });
  return syncNewReceipts({ lidl, supabase, householdId, maxPages: 4 });
}
