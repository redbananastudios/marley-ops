/**
 * Is this ledger failure PERMANENT, or will the next pass clear it?
 *
 * The distinction is the whole point of the payment watcher's error handling. A
 * transient failure is correctly swallowed and retried; a permanent one retried
 * silently forever is indistinguishable from "there was nothing to do", which
 * is exactly how Zoho's 2026-08-27 lock-out ran for hours behind a green
 * `{checked: 9, settled: 0}`.
 *
 * There is a third class beneath those two — a provider RATE LIMIT, which is
 * transient but integration-wide — and it gets its own test at the bottom of
 * this file rather than being folded into either. See `isLedgerRateLimited`.
 *
 * ## Why this is not just `isZohoAccessDenied`
 *
 * `lib/zoho.ts` exports that function and it is correct — but it opens with
 * `if (!(err instanceof ZohoError)) return false`, and since gate 17 the money
 * call sites no longer see `ZohoError`. They call through `lib/ledger`, whose
 * adapter converts every provider error into a {@link LedgerError} carrying the
 * provider's code and HTTP status.
 *
 * So the two fixes are individually right and silently incompatible: merging
 * `master`'s watcher onto `staging`'s seam compiles cleanly, passes, and
 * classifies EVERY lock-out as transient — reinstating the bug that fix was
 * written to close, with no failing test to say so. This module is the join.
 *
 * ## Why it lives on the seam
 *
 * "The books have locked us out permanently" is not a Zoho concept. Xero has
 * the same class — a revoked grant, a consumed refresh token past its grace, a
 * 401 — and the Xero adapter will raise it as the same `LedgerError`. Putting
 * the test here means the escalation path is written once and works for
 * whichever provider is configured, rather than being rediscovered at cutover.
 */
import { LedgerError } from "./types";

/**
 * Provider error codes that mean "this will not fix itself".
 *
 * Zoho: 57 and 6018 (deactivated org user — the 2026-08-27 lock-out). Xero
 * signals the same class through HTTP status rather than a body code, which the
 * status check below already covers.
 */
const PERMANENT_PROVIDER_CODES = new Set([57, 6018]);

/**
 * True when a ledger failure needs a human rather than another retry.
 *
 * Deliberately conservative in one direction and not the other: an unrecognised
 * error is treated as TRANSIENT, because escalating every blip to an ops alert
 * trains people to ignore the alert, and the blind-sweep counter still catches a
 * total outage even when no single error is classifiable. What must never be
 * missed is the permanent case, which is why each signal below is checked
 * independently rather than requiring agreement.
 *
 * Missing credentials count as permanent on purpose. Gating the alarm on the
 * same configuration that feeds the integration means dropping `ZOHO_*` or
 * `XERO_*` silences both the books and the only thing that would have reported
 * it — the same fail-closed reasoning as the bank-feed staleness rule.
 */
export function isLedgerAccessDenied(err: unknown): boolean {
  if (!(err instanceof LedgerError)) return false;
  if (err.providerCode !== undefined && PERMANENT_PROVIDER_CODES.has(err.providerCode)) return true;
  if (err.httpStatus === 401 || err.httpStatus === 403) return true;
  /**
   * Recognise the provider's own permanent-auth wording.
   *
   * Zoho's two cases carry no code and no status. Xero's carry a 400, which is
   * indistinguishable from an ordinary bad request by status alone — so a
   * revoked consent, a refresh token past its 60-day life, or a rotation lost
   * mid-write all arrived here as `LedgerError("Xero token request failed:
   * invalid_grant", undefined, 400)` and classified as TRANSIENT. That is the
   * failure this module was written to prevent, one provider over: the deduped
   * integration alert would never fire, and each quote would instead emit its
   * own "invoice FAILED" — five unrelated-looking incidents for one broken
   * integration, none of them naming the remedy.
   *
   * This file's doc comment promised Xero was covered because it raises the
   * same error TYPE. Sharing a type is not sharing a signal.
   *
   * The last two come from the token store, and both mean "there is no usable
   * grant here, and no retry will make one". `ledger_tokens` is created empty
   * — migration 0108 seeds nothing and the prod runbook says both tables land
   * that way — so NEVER AUTHORISED is the first state the Zoho→Xero cutover
   * passes through, not an exotic edge, and the row can be lost or rebuilt at
   * any point afterwards. A rotation that Xero consumed but we failed to
   * persist is the same dead end from the other side: the token we were using
   * is spent and its replacement went nowhere. Both need the identical human
   * click that a revoked grant needs, yet both carry no provider code and no
   * HTTP status, so the wording is the only signal there is. Matched on the
   * distinctive fragment rather than the whole sentence, because the sibling
   * failures in that module — a blip reading the row, a blip claiming the
   * lease, the lease wait timing out — are genuinely retryable and wear very
   * similar words.
   */
  return /credentials not configured|token refresh failed|not configured —|invalid_grant|invalid_client|no new refresh token|No Xero tenant is recorded|token row exists|need re-authorising|grant exactly one/i.test(
    err.message,
  );
}

/**
 * True when a ledger failure is the provider's RATE LIMIT rather than either
 * class above.
 *
 * A third class, because it matches neither. It is not a blip: Zoho meters
 * 1,000 API calls per organisation per DAY, and once an org has spent them
 * every raise, poll and read fails together until the counter resets — the same
 * blast radius as a lock-out, and the same reason it needs one integration-level
 * alarm instead of one "invoice FAILED" email per accepted quote. Unclassified,
 * it produced exactly the per-entity shape the 2026-08-27 decision exists to
 * prevent: five unrelated-looking incidents for one exhausted quota, none of
 * them naming the cause.
 *
 * And it is emphatically not access denied. `isLedgerAccessDenied` must keep
 * answering false here, because that alarm's remedy paragraphs are hardcoded
 * per provider — re-enable the org user, or re-consent at /api/xero/connect —
 * and neither is true of a quota. An alarm naming the wrong remedy is worse
 * than the noise it replaced: it sends an office looking for a disabled user
 * that was never disabled, and it clears itself at midnight regardless.
 *
 * Two independent signals, like the tests above:
 *  - HTTP 429, which is what both providers answer with;
 *  - the provider's own wording, because Zoho also returns a non-zero body
 *    `code` under a 200 on some endpoints, and its message ("exceeded the
 *    maximum call rate limit of 1,000") is then the only signal there is.
 *
 * The bare provider code is deliberately NOT a signal. Zoho's is 45, but a
 * small integer means different things in each provider's namespace and this
 * module is the shared seam — guessing across it is how a Xero validation error
 * would classify as a quota.
 *
 * NOT YET WIRED TO AN ALARM. The escalation sites (`lib/quote/accept-flow.ts`'s
 * three raise paths and the payment watcher) and the alert copy
 * (`lib/ops/zoho-access.ts`) both need a rate-limit branch of their own before
 * this changes what an operator sees; today it only makes the class nameable
 * and keeps it out of the lock-out remedy. Stated here rather than left to be
 * inferred from the absence of callers.
 */
export function isLedgerRateLimited(err: unknown): boolean {
  if (!(err instanceof LedgerError)) return false;
  if (err.httpStatus === 429) return true;
  return /rate limit|too many requests/i.test(err.message);
}
