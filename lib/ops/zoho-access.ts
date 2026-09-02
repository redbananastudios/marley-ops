import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { LedgerProvider } from "@/lib/ledger/types";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { reportOperationalIssue, resolveOperationalIssue } from "@/lib/ops/issues";

type Sb = SupabaseClient<Database>;

/**
 * One key for the WHOLE integration, not one per quote — and one key PER
 * PROVIDER, not one shared across them. An "integration" here is a provider
 * connection: Zoho's is Peter's org seat, Xero's is a rotating refresh token
 * in the ledger token store. They fail independently and are fixed by
 * different humans doing different things, so sharing a key would let a green
 * probe of the healthy provider auto-resolve the broken one's alarm — the
 * monitor erasing the very alert it exists to corroborate.
 *
 * Zoho's key is byte-identical to the pre-seam constant so any issue already
 * open in prod under it keeps resolving.
 */
export function ledgerAccessIssueKey(provider: LedgerProvider): string {
  return `${provider}:access-denied`;
}

/**
 * The quota's own key, deliberately NOT the lock-out's.
 *
 * The two states look identical from a call site — every call refused — and are
 * cleared by completely different evidence: a human re-enabling a user, versus a
 * counter rolling over on its own. Sharing a key would let either resolve the
 * other, so a midnight reset would silently close a genuine lock-out and a
 * re-enabled user would close a quota that is still spent.
 */
export function ledgerRateLimitIssueKey(provider: LedgerProvider): string {
  return `${provider}:rate-limited`;
}

/**
 * Everything about the lock-out alert that depends on WHICH books refused us.
 * The remedy line is the whole point of the alert (2026-08-27: five per-quote
 * failure emails and not one of them said the only thing that mattered), so it
 * must be the remedy for the provider that actually failed — Zoho's fix lives
 * in its Users & Roles screen, Xero's in re-consenting at /api/xero/connect,
 * which writes a fresh rotating refresh token to the ledger token store.
 *
 * The email paragraphs are deliberately INPUT-INDEPENDENT: sendOpsAlert's
 * content hash collapses byte-identical repeats at the provider, which is what
 * keeps a lock-out from filling the inbox while retries continue.
 */
const PROVIDER_COPY: Record<
  LedgerProvider,
  { event: string; issueMessage: string; subject: string; paragraphs: string[] }
> = {
  zoho: {
    event: "zoho.access_denied",
    issueMessage: "Zoho has locked the ops integration out — invoices and payment checks are failing.",
    subject: "Zoho access denied — the books integration is locked out",
    paragraphs: [
      "Ops can no longer read or write anything in Zoho, so deposit, commitment and balance invoices are not being raised and payments recorded in Zoho are not reaching ops.",
      "<strong>Fix:</strong> a Zoho admin on the MarleyMoves Ltd org opens Settings &rarr; Users &amp; Roles and marks the ops integration user <strong>Active</strong> again (its status is currently Inactive).",
      "Nothing needs replaying afterwards — every invoice retries itself on the next pass, and affected quotes keep their own error on the quote record.",
    ],
  },
  xero: {
    event: "xero.access_denied",
    issueMessage: "Xero has locked the ops integration out — invoices and payment checks are failing.",
    subject: "Xero access denied — the books integration is locked out",
    paragraphs: [
      "Ops can no longer read or write anything in the books, so deposit, commitment and balance invoices are not being raised and recorded payments are not reaching ops.",
      "<strong>Fix:</strong> an admin signs into ops and opens <strong>/api/xero/connect</strong> to re-authorise the connection (usually a dead or revoked refresh token — the fresh one is stored automatically in the ledger token store, nothing to paste anywhere).",
      "Nothing needs replaying afterwards — every invoice retries itself on the next pass, and affected quotes keep their own error on the quote record.",
    ],
  },
};

/**
 * The books have locked us out (deactivated user / revoked grant / dead
 * refresh token / missing creds).
 *
 * Every caller that touches the books funnels its access-denied failures here
 * instead of sending its own per-quote "FAILED" email, because this failure is
 * never about one quote: on 2026-08-27 the Zoho org user behind the refresh
 * token was deactivated, and each acceptance then fired its own alert naming
 * its own quote ref and amount. The office read five different-looking
 * incidents when there was one, and none of them said the only thing that
 * mattered — that a human has to re-enable the user in Zoho before ANY of it
 * could clear.
 *
 * So: one deduped operational issue per provider (occurrence_count carries the
 * volume) and one quote-agnostic email whose body is byte-identical every
 * time, so sendOpsAlert's content hash collapses the repeats at the provider
 * instead of filling the inbox. The per-quote detail is not lost — it is
 * already written to each quote's `zoho_*_error` column, which is where a
 * per-quote question belongs.
 *
 * `provider` is REQUIRED: since gate 18 both ledgers raise into this alert,
 * and the remedy text, the dedup key and the auto-resolve scope all hang off
 * which one actually refused us.
 *
 * Retries deliberately continue: the moment access is restored the invoice
 * paths self-heal on their next pass, with no replay to run by hand.
 */
export async function reportLedgerAccessDenied(
  sb: Sb,
  input: { provider: LedgerProvider; message: string; while: string },
): Promise<void> {
  const copy = PROVIDER_COPY[input.provider];
  await reportOperationalIssue(sb, {
    key: ledgerAccessIssueKey(input.provider),
    severity: "critical",
    source: input.provider,
    event: copy.event,
    message: copy.issueMessage,
    context: { provider: input.provider, ledgerError: input.message, failedWhile: input.while },
  });
  await sendOpsAlert(copy.subject, copy.paragraphs, "system");
}

/**
 * A call to `provider`'s books succeeded — clear THAT provider's lock-out
 * issue if one was open, and no other's. Scoped on purpose: a green Zoho probe
 * proves nothing about Xero, and before this took a provider the watchdog's
 * healthy-Zoho pass auto-cleared Xero lock-outs raised by failed invoice
 * raises.
 */
export async function resolveLedgerAccessDenied(sb: Sb, provider: LedgerProvider): Promise<void> {
  await resolveOperationalIssue(sb, ledgerAccessIssueKey(provider));
}

/* ------------------------------------------------------------ rate limits */

/**
 * The quota's copy, which exists precisely so it cannot borrow the lock-out's.
 *
 * A daily allowance and a deactivated account produce the same symptom — every
 * call refused — and opposite instructions. `PROVIDER_COPY` above tells a human
 * to re-enable a user or re-consent; do that here and the office spends its
 * evening in a permissions screen where nothing is wrong, while the thing
 * actually burning the calls keeps burning them and the counter clears itself at
 * the reset regardless. A confidently wrong remedy is worse than the per-quote
 * noise it replaced.
 *
 * So the wording is built around three facts that are true of a quota and false
 * of a lock-out: nobody is shut out, the calls are being spent by something we
 * are running, and it comes back on its own. Input-independent for the same
 * reason as the lock-out paragraphs — the content hash collapses the repeats
 * while retries continue.
 */
const RATE_LIMIT_COPY: Record<
  LedgerProvider,
  { event: string; issueMessage: string; subject: string; paragraphs: string[] }
> = {
  zoho: {
    event: "zoho.rate_limited",
    issueMessage:
      "Zoho's API allowance for the ops organisation is spent — invoices are not being raised until it resets.",
    subject: "Zoho API allowance spent — invoices are not being raised",
    paragraphs: [
      "Zoho is refusing every call ops makes, so deposit, commitment and balance invoices are not being raised and payments recorded in Zoho are not reaching ops.",
      "<strong>Nobody has been shut out</strong> — this is a volume limit, not a permissions problem, and there is nothing to switch back on. Zoho counts 1,000 API calls per organisation per day, this organisation has spent them, and the allowance resets when the day rolls over.",
      "<strong>What to do:</strong> find what is spending the calls and stop it — a job left looping, a bulk import, a test suite pointed at these books — or the next day's allowance goes the same way. Nothing needs replaying: every invoice retries itself once calls are answered again, and affected quotes keep their own error on the quote record.",
    ],
  },
  xero: {
    event: "xero.rate_limited",
    issueMessage:
      "Xero's API allowance for the ops organisation is spent — invoices are not being raised until it resets.",
    subject: "Xero API allowance spent — invoices are not being raised",
    paragraphs: [
      "Xero is refusing every call ops makes, so deposit, commitment and balance invoices are not being raised and recorded payments are not reaching ops.",
      "<strong>Nobody has been shut out</strong> — this is a volume limit, not a permissions problem, and nothing has been revoked. Xero meters how many calls these books will answer, this organisation has reached the limit, and the allowance resets on its own.",
      "<strong>What to do:</strong> find what is spending the calls and stop it — a job left looping, a bulk import, a test suite pointed at these books — or the allowance goes the same way again. Nothing needs replaying: every invoice retries itself once calls are answered again, and affected quotes keep their own error on the quote record.",
    ],
  },
};

/**
 * The books are answering, but refusing us on volume.
 *
 * Same collapse as the lock-out for the same reason — one broken integration is
 * one incident, not one per accepted quote — and separate from it because the
 * remedy differs. The staging org spent Zoho's daily allowance on 2026-09-02 and
 * every invoice-touching call failed for the rest of the day; nothing classified
 * a 429, so each quote fell through to its own "invoice FAILED" email naming its
 * own reference — one unrelated-looking incident per acceptance, for a single
 * exhausted counter, and none of them naming it. The same 1,000/day allowance
 * meters the live org.
 *
 * Reported as an error rather than critical on purpose: it is real (no customer
 * is being billed while it holds) but it is not a lock-out, and an alarm that
 * overstates what happened is the same defect as one that understates it.
 *
 * Retries continue, as they do for a lock-out — here they are the actual fix, so
 * the first pass after the reset heals everything with nothing to run by hand.
 */
export async function reportLedgerRateLimited(
  sb: Sb,
  input: { provider: LedgerProvider; message: string; while: string },
): Promise<void> {
  const copy = RATE_LIMIT_COPY[input.provider];
  await reportOperationalIssue(sb, {
    key: ledgerRateLimitIssueKey(input.provider),
    severity: "error",
    source: input.provider,
    event: copy.event,
    message: copy.issueMessage,
    context: { provider: input.provider, ledgerError: input.message, failedWhile: input.while },
  });
  await sendOpsAlert(copy.subject, copy.paragraphs, "system");
}

/**
 * `provider`'s books answered a call — clear THAT provider's quota issue.
 *
 * Scoped like the lock-out resolve, and needed for a reason the lock-out does
 * not have: nothing else can observe the reset. A lock-out ends when a human
 * acts and the next raise proves it; a quota ends unattended overnight, possibly
 * on a day with no acceptance at all, so without the watchdog's own green probe
 * clearing this the issue would sit open on the ops board indefinitely and read
 * as an ongoing outage.
 */
export async function resolveLedgerRateLimited(sb: Sb, provider: LedgerProvider): Promise<void> {
  await resolveOperationalIssue(sb, ledgerRateLimitIssueKey(provider));
}
