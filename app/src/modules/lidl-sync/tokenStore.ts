/**
 * Stockage du refresh token Lidl Plus. Sur le téléphone, il doit rester dans le stockage sécurisé
 * (Keychain iOS / Keystore Android via expo-secure-store) et ne jamais être envoyé à Supabase ni journalisé.
 *
 * Un jeton par foyer (version 0.29.7) : un téléphone connecté un jour au compte d'un autre foyer (les parents) ne lui
 * envoie jamais les tickets Lidl du premier, et chaque foyer garde son propre compte Lidl Plus.
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

/** Clé du jeton d'un foyer (lettres, chiffres, points, tirets : accepté par expo-secure-store). */
export const tokenKeyFor = (householdId: string) => `${KEY}.${householdId.replace(/[^A-Za-z0-9._-]/g, "")}`;

/**
 * À utiliser dans l'application : createSecureTokenStore(SecureStore, foyer.id). Sans foyer : l'ancienne clé unique
 * (versions 0.29.6 et avant).
 */
export function createSecureTokenStore(secureStore: SecureStoreLike, householdId?: string): TokenStore {
  const key = householdId ? tokenKeyFor(householdId) : KEY;
  return {
    getRefreshToken: () => secureStore.getItemAsync(key),
    setRefreshToken: (token) => secureStore.setItemAsync(key, token),
    clear: () => secureStore.deleteItemAsync(key),
  };
}

/**
 * Jeton rangé sous l'ancienne clé unique (avant la 0.29.7, quand le téléphone ne servait qu'un foyer) : il passe au
 * foyer qui l'a utilisé, et à lui seul. `ownsLegacy` dit si ce foyer a déjà récupéré des tickets (le foyer d'origine) ;
 * un autre foyer (nouveau compte des parents) ne le reprend jamais. Renvoie vrai si le jeton a été repris.
 */
export async function adoptLegacyToken(secureStore: SecureStoreLike, householdId: string, ownsLegacy: () => Promise<boolean>): Promise<boolean> {
  const legacy = await secureStore.getItemAsync(KEY);
  if (!legacy) return false;
  const key = tokenKeyFor(householdId);
  if (await secureStore.getItemAsync(key)) return false;
  if (!(await ownsLegacy())) return false;
  await secureStore.setItemAsync(key, legacy);
  await secureStore.deleteItemAsync(KEY);
  return true;
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
