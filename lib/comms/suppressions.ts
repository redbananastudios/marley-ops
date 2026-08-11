/**
 * Reconciling Resend's account-level suppression list against our leads.
 *
 * Why this exists, and why a webhook alone is not enough: from 9 July to 11
 * August 2026 the Resend webhook was subscribed to `email.received` ONLY. The
 * bounce handler was written, tested and deployed — and never fired once,
 * because no bounce event was ever sent to it. Two real customers hard-bounced,
 * Resend added them to its suppression list, and every subsequent email to them
 * was accepted with a 200 and silently dropped. Our database recorded all of it
 * as "sent". Nobody could have noticed from inside the app.
 *
 * The lesson is not "fix the webhook" (done) but that a delivery-failure signal
 * arriving over exactly one push channel has no failure detection: when it stops
 * arriving, the system looks identical to a world where nothing ever bounces.
 * So we also PULL the truth once a day. Resend's suppression list is the
 * authoritative answer to "which addresses will we silently fail to deliver to",
 * and reconciling it costs one request.
 *
 * The reconcile is a safety net, not the primary path — the webhook still does
 * the work within seconds. This catches whatever the webhook missed.
 */

import { log } from "@/lib/log";

export interface SuppressionEntry {
  email: string;
  /** "bounce" | "complaint" | manual, per Resend. */
  origin?: string | null;
  created_at?: string | null;
}

export interface ReconcilableLead {
  id: string;
  client_id: string | null;
  email: string | null;
  status: string;
  email_invalid_at: string | null;
}

export interface SuppressionFlag {
  leadId: string;
  clientId: string | null;
  email: string;
  /** When Resend suppressed it, so the flag carries the real date. */
  at: string | undefined;
  origin: string;
  kind: "hard" | "complaint";
}

/**
 * Leads whose status means an undeliverable address still matters. A declined
 * or completed lead is finished business: flagging it would raise a call task
 * for a job nobody is working, which is how a useful signal becomes noise the
 * office learns to ignore.
 */
const TERMINAL_STATUSES = new Set(["declined", "completed", "cancelled"]);

const norm = (email: string | null | undefined): string => (email ?? "").trim().toLowerCase();

/**
 * Resend stamps these as "2026-07-31 18:47:43.930459+00": a space instead of a
 * T and a two-digit offset, neither of which Date will parse. Normalise both,
 * and return undefined rather than throwing on anything unexpected — this runs
 * inside the chase cron, and a safety net that can take out the job it protects
 * is worse than no safety net at all.
 */
function toIso(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().replace(" ", "T");
  if (/([+-]\d{2})$/.test(s)) s = `${s}:00`;
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(s)) s = `${s}Z`; // no offset means UTC here
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Which live leads are sitting on a suppressed address without being flagged.
 * Pure, so the matching rules are unit-locked rather than buried in the cron.
 */
export function planSuppressionFlags(
  suppressions: readonly SuppressionEntry[],
  leads: readonly ReconcilableLead[],
): SuppressionFlag[] {
  const byEmail = new Map<string, SuppressionEntry>();
  for (const s of suppressions) {
    const key = norm(s.email);
    if (!key) continue;
    // Keep the earliest record for an address: the flag should carry the date
    // delivery actually started failing, not the date of a later duplicate.
    const existing = byEmail.get(key);
    if (!existing || (s.created_at ?? "") < (existing.created_at ?? "")) byEmail.set(key, s);
  }

  const out: SuppressionFlag[] = [];
  for (const lead of leads) {
    if (lead.email_invalid_at) continue; // already known
    if (TERMINAL_STATUSES.has(lead.status)) continue;
    const key = norm(lead.email);
    if (!key) continue;
    const hit = byEmail.get(key);
    if (!hit) continue;
    const origin = (hit.origin ?? "suppression").toLowerCase();
    out.push({
      leadId: lead.id,
      clientId: lead.client_id,
      email: lead.email!,
      at: toIso(hit.created_at),
      origin,
      kind: origin.includes("complaint") ? "complaint" : "hard",
    });
  }
  return out;
}

/**
 * Read Resend's suppression list. Returns null when unavailable (no key, or the
 * API is down) so the caller can skip the safety net without failing the cron —
 * a missing safety net must never take out the job it protects.
 */
export async function fetchResendSuppressions(): Promise<SuppressionEntry[] | null> {
  const key = process.env.MARLEY_RESEND_API_KEY || process.env.RESEND_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch("https://api.resend.com/suppressions?limit=100", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      log.warn("comms.suppressions.fetch_failed", { status: response.status });
      return null;
    }
    const body = (await response.json()) as { data?: SuppressionEntry[]; has_more?: boolean };
    // One page is plenty at our volume (3 entries after 13 months of trading).
    // If it ever isn't, say so loudly rather than silently reconciling a subset
    // — a partial safety net that looks complete is the failure this file exists
    // to prevent.
    if (body.has_more) log.warn("comms.suppressions.truncated", { returned: body.data?.length ?? 0 });
    return body.data ?? [];
  } catch (error) {
    log.warn("comms.suppressions.fetch_threw", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
