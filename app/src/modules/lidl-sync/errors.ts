/** Erreurs de la synchronisation Lidl Plus. Les messages ne contiennent jamais de jeton. */

export type LidlErrorCode = "reauth_required" | "lidl_unavailable" | "lidl_rejected" | "parse_failed" | "import_failed";

export class LidlSyncError extends Error {
  constructor(readonly code: LidlErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "LidlSyncError";
  }
}

/** Le refresh token a expiré ou été révoqué : l'utilisateur doit se reconnecter à Lidl Plus. */
export class ReauthRequiredError extends LidlSyncError {
  constructor(message = "La connexion à Lidl Plus a expiré. Reconnectez-vous pour reprendre la synchronisation.") {
    super("reauth_required", message);
    this.name = "ReauthRequiredError";
  }
}
