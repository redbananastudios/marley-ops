/**
 * Xero half of the watchdog's books probe — SERVER ONLY.
 *
 * The health-probe rule (2026-08-27, learned the hard way on Zoho): a probe
 * must exercise the same scope as the thing it certifies. Zoho's
 * `GET /organizations` kept answering for a deactivated user, so a probe built
 * on it stayed green straight through the lock-out. Xero has the same trap one
 * layer down: `GET /connections` answers with just a bare access token, saying
 * nothing about whether the ORG can still be addressed.
 *
 * So this probes `GET /Organisation` through `xeroFetch`, which exercises every
 * link that actually dies silently in this integration:
 *
 *  - **missing credentials** — `requireConfig` throws "Xero is not configured —"
 *    (the alarm must not depend on the config it watches);
 *  - **never authorised** — the token store throws "No xero token row exists"
 *    (`ledger_tokens` is created empty, so this is the state the cutover starts
 *    in whenever the env flip lands before an admin runs /api/xero/connect);
 *  - **a dead or revoked refresh token** — `postToken` throws
 *    "Xero token request failed: invalid_grant" (the 60-day idle expiry, the
 *    live risk for an environment authorised early and left on zoho);
 *  - **a lost tenant** — `xeroAuth` throws "No Xero tenant is recorded"
 *    (the Demo Company resets every 28 days);
 *  - **a disconnected organisation** — the read itself comes back 401/403.
 *
 * Each is classified by `isLedgerAccessDenied`, the same test the invoice paths
 * use, so the probe and the raise paths cannot disagree about what counts as a
 * lock-out. A timeout or a 5xx stays transient: it clears on the next pass and
 * must not page anyone at 3am.
 *
 * Not in `xero-client.ts` because that module's `readOrganisation` deliberately
 * swallows failures for the live-write guard (an unreadable class must read as
 * LIVE, never as permission). This probe needs the opposite: the failure IS the
 * answer.
 */
import "server-only";

import { isLedgerAccessDenied } from "./access";
import { xeroFetch } from "./xero-client";
import type { LedgerAccessCheck } from "./types";
import { LedgerError } from "./types";

export async function checkXeroAccess(): Promise<LedgerAccessCheck> {
  try {
    const res = await xeroFetch("/Organisation");
    if (!res.ok) {
      // Thrown and immediately caught so a 401/403 runs through the SAME
      // classifier as an error raised upstream — one definition of "lock-out".
      throw new LedgerError(`Xero organisation read failed (HTTP ${res.status})`, undefined, res.status);
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      accessDenied: isLedgerAccessDenied(err),
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
