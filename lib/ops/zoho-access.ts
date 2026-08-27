import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";

type Sb = SupabaseClient<Database>;

/** One key for the WHOLE integration, not one per quote — see below. */
export const ZOHO_ACCESS_ISSUE_KEY = "zoho:access-denied";

/**
 * Zoho has locked us out (deactivated user / revoked grant / missing creds).
 *
 * Every caller that touches the books funnels its access-denied failures here
 * instead of sending its own per-quote "FAILED" email, because this failure is
 * never about one quote: on 2026-08-27 the org user behind the refresh token
 * was deactivated, and each acceptance then fired its own alert naming its own
 * quote ref and amount. The office read five different-looking incidents when
 * there was one, and none of them said the only thing that mattered — that a
 * human has to re-enable the user in Zoho before ANY of it can clear.
 *
 * So: one deduped operational issue (occurrence_count carries the volume) and
 * one quote-agnostic email whose body is byte-identical every time, so
 * sendOpsAlert's content hash collapses the repeats at the provider instead of
 * filling the inbox. The per-quote detail is not lost — it is already written
 * to each quote's `zoho_*_error` column, which is where a per-quote question
 * belongs.
 *
 * Retries deliberately continue: the moment the account is re-enabled the
 * invoice paths self-heal on their next pass, with no replay to run by hand.
 */
export async function reportZohoAccessDenied(
  sb: Sb,
  input: { message: string; while: string },
): Promise<void> {
  await reportOperationalIssue(sb, {
    key: ZOHO_ACCESS_ISSUE_KEY,
    severity: "critical",
    source: "zoho",
    event: "zoho.access_denied",
    message: "Zoho has locked the ops integration out — invoices and payment checks are failing.",
    context: { zohoError: input.message, failedWhile: input.while },
  });
  await sendOpsAlert(
    "Zoho access denied — the books integration is locked out",
    [
      "Ops can no longer read or write anything in Zoho, so deposit, commitment and balance invoices are not being raised and payments recorded in Zoho are not reaching ops.",
      "<strong>Fix:</strong> a Zoho admin on the MarleyMoves Ltd org opens Settings &rarr; Users &amp; Roles and marks the ops integration user <strong>Active</strong> again (its status is currently Inactive).",
      "Nothing needs replaying afterwards — every invoice retries itself on the next pass, and affected quotes keep their own error on the quote record.",
    ],
    "system",
  );
}

/** A Zoho call succeeded — clear the lock-out issue if one was open. */
export async function resolveZohoAccessDenied(sb: Sb): Promise<void> {
  await resolveOperationalIssue(sb, ZOHO_ACCESS_ISSUE_KEY);
}
