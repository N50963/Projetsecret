/**
 * Synchronisation des nouveaux tickets Lidl Plus vers Supabase, lancée depuis le téléphone
 * (bouton « Synchroniser maintenant », ouverture de l'application ou tâche de fond).
 *
 * - Ne télécharge que les tickets absents de la base (liste parcourue page par page, du plus récent au plus ancien).
 * - Importe du plus ancien au plus récent ; un ticket en échec n'empêche pas les suivants.
 * - L'import est idempotent côté base : relancer après une interruption ne crée aucun doublon.
 * - Chaque exécution est tracée dans `sync_runs` (statut, nombre de tickets, erreur sans donnée sensible).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { LidlSyncError, ReauthRequiredError } from "./errors";
import type { LidlClient, TicketSummary } from "./lidlClient";
import { buildReceiptPayload } from "./payload";

export type SyncStatus = "success" | "partial" | "reauth_required" | "error";

export interface SyncResult {
  status: SyncStatus;
  newReceipts: number;
  importedIds: string[];
  failures: Array<{ ticketId: string; code: string; message: string }>;
  errorCode?: string;
  message?: string;
}

export interface SyncOptions {
  lidl: LidlClient;
  supabase: SupabaseClient;
  householdId: string;
  /** Nombre maximal de pages de 25 tickets à parcourir (1re synchronisation d'un foyer : prévoir large). */
  maxPages?: number;
}

const SOURCE = "lidl_plus_fr";
let running: Promise<SyncResult> | null = null;

/** Une seule synchronisation à la fois sur l'appareil : un second appel attend la première. */
export function syncNewReceipts(options: SyncOptions): Promise<SyncResult> {
  if (!running) {
    running = runSync(options).finally(() => {
      running = null;
    });
  }
  return running;
}

async function knownReceiptIds(supabase: SupabaseClient, householdId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from("receipts").select("external_id").eq("household_id", householdId).eq("source", SOURCE);
  if (error) throw new LidlSyncError("import_failed", `Lecture des tickets déjà importés impossible : ${error.message}`);
  return new Set((data ?? []).map((r: { external_id: string }) => r.external_id));
}

async function findNewTickets(lidl: LidlClient, known: Set<string>, maxPages: number): Promise<TicketSummary[]> {
  const found: TicketSummary[] = [];
  let seen = 0;
  for (let page = 1; page <= maxPages; page++) {
    const result = await lidl.listTickets(page);
    const fresh = result.tickets.filter((t) => !known.has(t.id));
    found.push(...fresh);
    seen += result.tickets.length;
    // La liste est triée du plus récent au plus ancien : une page sans nouveauté signifie que le reste est déjà connu.
    if (result.tickets.length === 0 || fresh.length === 0 || seen >= result.totalCount) break;
  }
  return found.sort((a, b) => a.date.localeCompare(b.date));
}

async function startRun(supabase: SupabaseClient, householdId: string): Promise<string | null> {
  const { data } = await supabase.from("sync_runs").insert({ household_id: householdId, source: SOURCE, status: "running" }).select("id").single();
  return (data as { id: string } | null)?.id ?? null;
}

async function finishRun(supabase: SupabaseClient, runId: string | null, result: SyncResult): Promise<void> {
  if (!runId) return;
  await supabase
    .from("sync_runs")
    .update({
      status: result.status,
      finished_at: new Date().toISOString(),
      new_receipts: result.newReceipts,
      failed_receipts: result.failures.length,
      error_code: result.errorCode ?? result.failures[0]?.code ?? null,
      error_message: (result.message ?? result.failures[0]?.message ?? null)?.slice(0, 500) ?? null,
    })
    .eq("id", runId);
}

async function runSync({ lidl, supabase, householdId, maxPages = 10 }: SyncOptions): Promise<SyncResult> {
  const runId = await startRun(supabase, householdId);
  const result: SyncResult = { status: "success", newReceipts: 0, importedIds: [], failures: [] };
  try {
    const known = await knownReceiptIds(supabase, householdId);
    const tickets = await findNewTickets(lidl, known, maxPages);
    for (const summary of tickets) {
      try {
        const detail = await lidl.getTicket(summary.id);
        const { payload } = buildReceiptPayload(detail, summary);
        const { error } = await supabase.rpc("import_receipt", { p_household: householdId, p: payload });
        if (error) throw new LidlSyncError("import_failed", `Enregistrement refusé : ${error.message}`);
        result.importedIds.push(summary.id);
        result.newReceipts += 1;
      } catch (error) {
        if (error instanceof ReauthRequiredError) throw error;
        const e = error instanceof LidlSyncError ? error : new LidlSyncError("import_failed", String(error));
        result.failures.push({ ticketId: summary.id, code: e.code, message: e.message });
      }
    }
    if (result.failures.length > 0) result.status = result.newReceipts > 0 ? "partial" : "error";
  } catch (error) {
    if (error instanceof ReauthRequiredError) {
      Object.assign(result, { status: "reauth_required", errorCode: error.code, message: error.message });
    } else {
      const e = error instanceof LidlSyncError ? error : new LidlSyncError("lidl_unavailable", String(error));
      Object.assign(result, { status: "error", errorCode: e.code, message: e.message });
    }
  }
  await finishRun(supabase, runId, result);
  return result;
}
