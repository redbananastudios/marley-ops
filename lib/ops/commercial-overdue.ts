import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBookingRows } from "@/lib/bookings/load-signals";
import { log } from "@/lib/log";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";

/**
 * Commercial credit control — the internal half of PRD §3.10.
 *
 * A commercial customer is NEVER chased by email. That is a deliberate
 * decision, and it is the reason this file exists: "no automated chase" means
 * the customer is not emailed, not that nobody notices. Without an alarm, an
 * unpaid commercial invoice is visible only to whoever happens to open
 * /bookings and read to the bottom of the page — and an invoice nobody opens
 * ages indefinitely while every surface stays green. That is the same shape
 * this codebase has been bitten by repeatedly: the absence of a finding read as
 * good news.
 *
 * TWO alarms, because there are two different silences and they have different
 * remedies:
 *
 *  1. `commercial:invoice-overdue` — past the client's agreed terms. Somebody
 *     needs to ring them.
 *  2. `commercial:terms-date-missing` — invoiced, but `commercial_due_date` is
 *     null, so it can NEVER become overdue and alarm (1) can never fire for it.
 *     Without this second alarm the first one has a hole exactly the size of
 *     its own blind spot: the invoices least likely to be chased are the ones
 *     no rule can even claim are late. The remedy is to put the terms on the
 *     invoice, not to chase.
 *
 * Both are deduped to ONE key across every quote rather than one alarm per
 * invoice. Five overdue invoices are one credit-control job, and five separate
 * alarms read as five unrelated incidents while burying the single thing to do
 * about them. `occurrence_count` carries the volume and the context carries the
 * refs.
 */

export const COMMERCIAL_OVERDUE_ISSUE_KEY = "commercial:invoice-overdue";
export const COMMERCIAL_TERMS_MISSING_ISSUE_KEY = "commercial:terms-date-missing";

export interface CommercialOverdueSweep {
  /** Refs past their terms date. */
  overdue: string[];
  /** Refs invoiced with no terms date — unassessable, not fine. */
  termsMissing: string[];
  /** False when the read failed, so nothing about this sweep may be reported
   *  as clean. */
  checked: boolean;
}

/**
 * Sweep the commercial ladder and raise or clear both alarms.
 *
 * Classification comes from `loadBookingRows`, the SAME loader /bookings and
 * /payments render from, rather than a query of its own. A second query would
 * be a second definition of "overdue", and the two would drift — the alarm
 * would fire for rows the office cannot find on the page, or stay silent for
 * rows the page shows in red. One classifier, three surfaces.
 *
 * A FAILED read resolves nothing. Clearing an alarm on an answer we never got
 * is how a monitor reports good news about a check that did not run; the sweep
 * returns `checked: false` and the alarms stand until a read succeeds.
 */
export async function sweepCommercialOverdue(
  sb: SupabaseClient,
): Promise<CommercialOverdueSweep> {
  let overdue: string[] = [];
  let termsMissing: string[] = [];
  try {
    const { rows } = await loadBookingRows(sb);
    overdue = rows.filter((r) => r.bucket === "commercial_overdue").map((r) => r.quoteRef);
    termsMissing = rows
      .filter((r) => r.bucket === "commercial_terms_unknown")
      .map((r) => r.quoteRef);
  } catch (error) {
    log.warn("ops.commercial_overdue.read_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { overdue: [], termsMissing: [], checked: false };
  }

  if (overdue.length) {
    await reportOperationalIssue(sb, {
      key: COMMERCIAL_OVERDUE_ISSUE_KEY,
      severity: "warning",
      source: "commercial",
      event: "commercial.invoice_overdue",
      message:
        "A commercial invoice is past the client's agreed terms. Commercial customers are never chased by email (PRD §3.10), so this is ours to collect — call them.",
      context: { count: overdue.length, quoteRefs: overdue.slice(0, 20) },
    });
  } else {
    await resolveOperationalIssue(sb, COMMERCIAL_OVERDUE_ISSUE_KEY);
  }

  if (termsMissing.length) {
    await reportOperationalIssue(sb, {
      key: COMMERCIAL_TERMS_MISSING_ISSUE_KEY,
      severity: "warning",
      source: "commercial",
      event: "commercial.terms_date_missing",
      message:
        "A commercial invoice has no terms date, so nothing can ever say it is late — it will not appear in the overdue alarm however long it goes unpaid. Set the client's payment terms and re-raise, or collect it by hand.",
      context: { count: termsMissing.length, quoteRefs: termsMissing.slice(0, 20) },
    });
  } else {
    await resolveOperationalIssue(sb, COMMERCIAL_TERMS_MISSING_ISSUE_KEY);
  }

  return { overdue, termsMissing, checked: true };
}
