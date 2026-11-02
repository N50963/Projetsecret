/**
 * Messages d'erreur lisibles. Sans réseau, Android renvoie « fetch failed: java.net.UnknownHostException: Unable to
 * resolve host … » : le foyer lit à la place que la connexion manque, avec l'action concernée (« Choix non enregistré »).
 * Les autres erreurs perdent leurs préfixes techniques (« Error: », « TypeError: »).
 */
const NETWORK = /fetch failed|failed to send a request|network request failed|failed to fetch|networkerror|load failed|unknownhost|unable to resolve host|no address associated|enotfound|econnreset|econnrefused|connectexception|sockettimeout|timed? ?out|connection (?:abort|reset|refused)|internet/i;

const TECHNICAL = /\b(?:Type|Range|Reference|Syntax|FunctionsHttp|FunctionsFetch|FunctionsRelay|AuthApi|AuthRetryableFetch|Storage)?Error:\s*/g;

export const NO_NETWORK = "pas de connexion Internet. Vérifiez le Wi-Fi ou les données mobiles, puis réessayez.";

export function isNetworkError(e: unknown): boolean {
  return NETWORK.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));
}

export function errorText(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).trim();
  // Action concernée, quand le message commence par elle (« Refus non enregistré : … »).
  const action = raw.replace(TECHNICAL, "").match(/^([^:]{3,80}?)\s:\s/)?.[1];
  if (isNetworkError(e)) {
    const text = action && !NETWORK.test(action) ? `${action} : ${NO_NETWORK}` : NO_NETWORK;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  const clean = raw.replace(TECHNICAL, "").trim();
  return clean || "Une erreur inattendue s'est produite. Réessayez.";
}

/**
 * Enregistrement secondaire (refus d'une proposition) : réessayé en silence, 3 fois (3 s, 10 s, 30 s), sans alerte s'il
 * échoue encore — l'écran en tient déjà compte.
 */
export function retryQuietly(write: () => Promise<unknown>, delays = [3000, 10000, 30000]): void {
  write().catch(() => {
    const [first, ...rest] = delays;
    if (first === undefined) return;
    setTimeout(() => retryQuietly(write, rest), first);
  });
}
