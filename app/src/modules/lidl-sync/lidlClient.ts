/**
 * Client des points d'accès (non officiels) de l'application Lidl Plus, utilisés directement depuis le téléphone.
 * - Le refresh token vient de la connexion initiale faite par l'utilisateur (reCAPTCHA) et reste sur l'appareil.
 * - Si Lidl renvoie un nouveau refresh token, il est enregistré avant toute autre requête.
 * - Détail d'un ticket : l'API v2 répond 400 pour la France, on interroge donc la v3 (v2 en secours).
 */

import { LidlSyncError, ReauthRequiredError } from "./errors";
import type { TokenStore } from "./tokenStore";

const AUTH_URL = "https://accounts.lidl.com/connect/token";
const TICKETS_V2 = "https://tickets.lidlplus.com/api/v2";
const TICKETS_V3 = "https://tickets.lidlplus.com/api/v3";
// base64("LidlPlusNativeClient:secret") : identifiant public de l'application Lidl Plus.
export const LIDL_BASIC_AUTH = "TGlkbFBsdXNOYXRpdmVDbGllbnQ6c2VjcmV0";

export interface TicketSummary {
  id: string;
  date: string;
  totalAmount: number;
  articlesCount?: number;
  storeCode?: string;
  [key: string]: unknown;
}

export interface TicketPage {
  page: number;
  size: number;
  totalCount: number;
  tickets: TicketSummary[];
}

export interface TicketDetail {
  id: string;
  date: string;
  totalAmount: number;
  htmlPrintedReceipt?: string;
  store?: { id?: string; name?: string; locality?: string; postalCode?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface LidlClientOptions {
  tokenStore: TokenStore;
  country?: string;
  language?: string;
  appVersion?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class LidlClient {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private readonly country: string;
  private readonly language: string;
  private readonly appVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: LidlClientOptions) {
    this.country = (options.country ?? "FR").toUpperCase();
    this.language = (options.language ?? "fr").toLowerCase();
    this.appVersion = options.appVersion ?? "17.9.3";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Requête avec délai maximal et nouvelles tentatives (429, 5xx, réseau) espacées de 1 s, 2 s, 4 s. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        if (!RETRYABLE.has(response.status) || attempt === this.maxRetries) return response;
        lastError = new LidlSyncError("lidl_unavailable", `Lidl a répondu ${response.status}`, response.status);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries) break;
      } finally {
        clearTimeout(timer);
      }
      await this.sleep(1000 * 2 ** attempt);
    }
    throw lastError instanceof LidlSyncError
      ? lastError
      : new LidlSyncError("lidl_unavailable", "Lidl Plus est injoignable pour le moment.");
  }

  /** Jeton d'accès valide (renouvelé 60 s avant expiration). */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.now() < this.expiresAt - 60_000) return this.accessToken;
    const refreshToken = await this.options.tokenStore.getRefreshToken();
    if (!refreshToken) throw new ReauthRequiredError("Aucune connexion Lidl Plus enregistrée sur cet appareil.");
    const response = await this.send(AUTH_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${LIDL_BASIC_AUTH}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
    if (response.status === 400 || response.status === 401) throw new ReauthRequiredError();
    if (!response.ok) throw new LidlSyncError("lidl_rejected", `Renouvellement refusé par Lidl (${response.status}).`, response.status);
    const body = (await response.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    if (body.refresh_token && body.refresh_token !== refreshToken) {
      await this.options.tokenStore.setRefreshToken(body.refresh_token);
    }
    this.accessToken = body.access_token;
    this.expiresAt = this.now() + body.expires_in * 1000;
    return this.accessToken;
  }

  private async getJson<T>(url: string, retryOnUnauthorized = true): Promise<{ status: number; body: T | null }> {
    const token = await this.getAccessToken();
    const response = await this.send(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "App-Version": this.appVersion,
        "Operating-System": "iOs",
        App: "com.lidl.eci.lidl.plus",
        "Accept-Language": this.language,
      },
    });
    if (response.status === 401 && retryOnUnauthorized) {
      this.accessToken = null;
      return this.getJson<T>(url, false);
    }
    if (response.status === 401) throw new ReauthRequiredError();
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: (await response.json()) as T };
  }

  /** Une page de la liste des tickets (les plus récents d'abord). */
  async listTickets(page: number): Promise<TicketPage> {
    const url = `${TICKETS_V2}/${this.country}/tickets?pageNumber=${page}&onlyFavorite=false`;
    const { status, body } = await this.getJson<TicketPage>(url);
    if (!body) throw new LidlSyncError("lidl_rejected", `Liste des tickets refusée par Lidl (${status}).`, status);
    return body;
  }

  /** Détail d'un ticket, dont le ticket imprimé au format HTML. */
  async getTicket(id: string): Promise<TicketDetail> {
    for (const base of [TICKETS_V3, TICKETS_V2]) {
      const { body } = await this.getJson<TicketDetail>(`${base}/${this.country}/tickets/${encodeURIComponent(id)}`);
      if (body) return body;
    }
    throw new LidlSyncError("lidl_rejected", "Détail du ticket refusé par Lidl.");
  }
}
