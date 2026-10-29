/**
 * Stockage du refresh token Lidl Plus. Sur le téléphone, il doit rester dans le stockage sécurisé
 * (Keychain iOS / Keystore Android via expo-secure-store) et ne jamais être envoyé à Supabase ni journalisé.
 */

export interface TokenStore {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

const KEY = "lidl_plus_refresh_token";

/** Sous-ensemble de l'API d'expo-secure-store utilisé ici (injecté pour garder ce module testable). */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** À utiliser dans l'application : createSecureTokenStore(await import("expo-secure-store")). */
export function createSecureTokenStore(secureStore: SecureStoreLike): TokenStore {
  return {
    getRefreshToken: () => secureStore.getItemAsync(KEY),
    setRefreshToken: (token) => secureStore.setItemAsync(KEY, token),
    clear: () => secureStore.deleteItemAsync(KEY),
  };
}

/** Pour les tests. */
export class MemoryTokenStore implements TokenStore {
  constructor(private token: string | null = null) {}
  async getRefreshToken() {
    return this.token;
  }
  async setRefreshToken(token: string) {
    this.token = token;
  }
  async clear() {
    this.token = null;
  }
}
