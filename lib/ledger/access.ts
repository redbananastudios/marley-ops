/**
 * Is this ledger failure PERMANENT, or will the next pass clear it?
 *
 * The distinction is the whole point of the payment watcher's error handling. A
 * transient failure is correctly swallowed and retried; a permanent one retried
 * silently forever is indistinguishable from "there was nothing to do", which
 * is exactly how Zoho's 2026-08-27 lock-out ran for hours behind a green
 * `{checked: 9, settled: 0}`.
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
   */
  return /credentials not configured|token refresh failed|not configured —|invalid_grant|invalid_client|no new refresh token|No Xero tenant is recorded/i.test(
    err.message,
  );
}
