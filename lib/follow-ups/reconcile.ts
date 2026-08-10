/**
 * Close follow-up tasks whose work is already done.
 *
 * The triggers that OPEN tasks are sound; nothing reliably closed them again, so
 * /follow-ups accumulated work that no longer existed (Peter, 2026-08-10 — three
 * of seven open tasks were stale). Two shapes leaked:
 *
 *  - `survey_completed` says "build and send the quote". It closes at send, but
 *    only since 2026-08-07, so anything quoted before that is stuck forever.
 *  - `inbound_reply` says "the customer replied — respond". Nothing ever closed
 *    it, so a reply that was answered days ago, on a job since won, still sits
 *    there overdue.
 *
 * Deliberately narrow. Only `quote_followup` and reply-sourced `custom` tasks are
 * touched: `balance` and `deposit` chases live ON confirmed leads and closing
 * them "because the lead is settled" would silence the money ladder, and manual
 * `no_answer` callbacks are a human's own reminder to nobody else's schedule.
 */

export const SETTLED_LEAD_STATUSES = ["confirmed", "completed", "declined"] as const;
const RESOLVED_QUOTE_STATUSES = ["accepted", "rejected", "superseded"] as const;

export interface OpenFollowUp {
  id: string;
  lead_id: string | null;
  quote_id: string | null;
  reason: string | null;
  source: string | null;
}

export interface LeadState {
  id: string;
  status: string | null;
}

export interface QuoteState {
  id: string;
  lead_id: string | null;
  status: string | null;
  email_sent_at: string | null;
}

export interface Closure {
  id: string;
  /** Written to the activity trail so a vanished task is explainable. */
  why: string;
}

/** Only these can be auto-closed — see the note above about balance/deposit. */
function isCloseable(f: OpenFollowUp): boolean {
  return f.reason === "quote_followup" || (f.reason === "custom" && f.source === "inbound_reply");
}

export function planFollowUpClosures(
  followUps: readonly OpenFollowUp[],
  leads: readonly LeadState[],
  quotes: readonly QuoteState[],
): Closure[] {
  const leadStatus = new Map(leads.map((l) => [l.id, l.status]));
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  const sentByLead = new Set(
    quotes.filter((q) => q.lead_id && q.email_sent_at).map((q) => q.lead_id as string),
  );

  const out: Closure[] = [];
  for (const f of followUps) {
    if (!isCloseable(f) || !f.lead_id) continue;

    const status = leadStatus.get(f.lead_id) ?? null;
    if (status && (SETTLED_LEAD_STATUSES as readonly string[]).includes(status)) {
      out.push({ id: f.id, why: `lead is ${status} — nothing left to chase` });
      continue;
    }

    if (f.source === "survey_completed" && sentByLead.has(f.lead_id)) {
      out.push({ id: f.id, why: "the quote has been sent" });
      continue;
    }

    if (f.source === "inbound_reply") {
      const q = f.quote_id ? quoteById.get(f.quote_id) : null;
      if (q && q.status && (RESOLVED_QUOTE_STATUSES as readonly string[]).includes(q.status)) {
        out.push({ id: f.id, why: `quote is ${q.status} — the reply was dealt with` });
      }
    }
  }
  return out;
}
