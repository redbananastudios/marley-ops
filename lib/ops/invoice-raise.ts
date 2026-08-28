import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";

type Sb = SupabaseClient<Database>;

/** One key for the whole billing rail, not one per quote — see below. */
export const INVOICE_RAISE_ISSUE_KEY = "ledger:invoice-raise-failed";

/** Which rung of the money ladder failed to produce a document. */
export type InvoiceKind = "deposit" | "commitment" | "balance";

/**
 * An invoice could not be raised in the books, for a reason that is not a
 * lock-out (`reportZohoAccessDenied` owns that one).
 *
 * Until this existed the failure was written to `quotes.zoho_<kind>_error` and
 * emailed per quote, and NOWHERE else — no operational issue, so the ops board
 * and the daily digest both read clean while customers went unbilled. On
 * 2026-08-28 four raises failed inside an hour on Zoho's "exceeded the maximum
 * call rate limit of 1,000" and `operational_issues` held nothing newer than
 * 2026-08-20. Nothing surfaces `zoho_<kind>_error` in the UI, so those four
 * customers were invisible: the only durable record of an unraised invoice sat
 * in a column no screen reads. That is the "I could not check must never render
 * as nothing to report" shape this codebase has now been bitten by five times.
 *
 * Deduped to ONE key across every quote and every rung, exactly like
 * `zoho:access-denied`: a rate limit, an expired token or a books outage stops
 * ALL billing, and ten quote-shaped alarms for one cause read as ten unrelated
 * incidents while burying the single thing to do about it. `occurrence_count`
 * carries the volume; the per-quote fact stays on the quote's own error column,
 * which is where a per-quote question belongs.
 */
export async function reportInvoiceRaiseFailed(
  sb: Sb,
  input: { message: string; kind: InvoiceKind; quoteRef: string | null; reference?: string | null },
): Promise<void> {
  await reportOperationalIssue(sb, {
    key: INVOICE_RAISE_ISSUE_KEY,
    severity: "error",
    source: "ledger",
    event: "ledger.invoice_raise_failed",
    message:
      "An invoice could not be raised in the books, so the customer has not been billed — clear the cause named in the error, then re-raise it from the quote.",
    context: {
      ledgerError: input.message,
      invoiceKind: input.kind,
      quoteRef: input.quoteRef,
      reference: input.reference ?? null,
    },
  });
}

/**
 * A raise succeeded — clear the rail-level alarm, but ONLY when no other quote
 * is still carrying a raise error.
 *
 * Resolving on this quote's success alone would green the board while another
 * customer sits unbilled, and since nothing renders `zoho_<kind>_error` that
 * customer would then be invisible — re-creating the exact silence this alarm
 * was added to break. The deposit and commitment rungs both null their error
 * column on success, so an outstanding one is a live, unbilled quote.
 *
 * A read that FAILED proves nothing, so it leaves the alarm standing rather
 * than clear it on an answer we never got. The balance rung stores no error
 * column of its own; a balance failure that outlives a deposit success is
 * re-reported by the T-7 chase cron on its next pass.
 */
export async function resolveInvoiceRaiseFailed(sb: Sb): Promise<void> {
  const { data, error } = await sb
    .from("quotes")
    .select("id")
    .or("zoho_deposit_error.not.is.null,zoho_commitment_error.not.is.null")
    .limit(1);
  if (error || data?.length) return;
  await resolveOperationalIssue(sb, INVOICE_RAISE_ISSUE_KEY);
}
