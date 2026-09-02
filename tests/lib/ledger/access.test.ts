import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LedgerError } from "@/lib/ledger";
import { isLedgerAccessDenied, isLedgerRateLimited } from "@/lib/ledger/access";
import { ZohoError } from "@/lib/zoho";

/**
 * This module exists because two correct fixes were silently incompatible.
 *
 * `master` taught the payment watcher to tell a permanent Zoho lock-out from a
 * transient blip, using `isZohoAccessDenied` — which opens by rejecting
 * anything that is not a `ZohoError`. `staging` had already moved every money
 * call site behind `lib/ledger`, whose adapter converts provider errors into
 * `LedgerError`. Merge the two and every lock-out classifies as transient.
 *
 * The watcher's own test caught that. The THREE invoice-raise paths that make
 * the same call had no test at all, and would have stopped escalating in
 * silence — so the last case here is a source guard over the whole class rather
 * than one more example of it.
 */
describe("isLedgerAccessDenied — permanent, not transient", () => {
  it("recognises the provider codes that mean a deactivated account", () => {
    // 6018 is the code Zoho returned throughout the 2026-08-27 lock-out.
    expect(isLedgerAccessDenied(new LedgerError("denied", 6018))).toBe(true);
    expect(isLedgerAccessDenied(new LedgerError("denied", 57))).toBe(true);
  });

  it("recognises an auth status even with no provider code", () => {
    expect(isLedgerAccessDenied(new LedgerError("nope", undefined, 401))).toBe(true);
    expect(isLedgerAccessDenied(new LedgerError("nope", undefined, 403))).toBe(true);
  });

  /**
   * Missing credentials count as permanent deliberately. Gating the alarm on
   * the same configuration that feeds the integration means dropping the env
   * vars silences both the books and the only thing that would have said so.
   */
  it("treats a credentials failure as permanent, not as a blip", () => {
    expect(isLedgerAccessDenied(new LedgerError("Zoho credentials not configured"))).toBe(true);
    expect(isLedgerAccessDenied(new LedgerError("token refresh failed (400)"))).toBe(true);
  });

  /**
   * The other direction matters as much. Escalating an ordinary timeout puts a
   * permanent-looking ops alert on something that clears itself, and an alert
   * people learn to ignore protects nothing.
   */
  it("leaves transient failures alone", () => {
    expect(isLedgerAccessDenied(new LedgerError("socket hang up"))).toBe(false);
    expect(isLedgerAccessDenied(new LedgerError("gateway timeout", undefined, 504))).toBe(false);
    expect(isLedgerAccessDenied(new LedgerError("server error", undefined, 500))).toBe(false);
    expect(isLedgerAccessDenied(new Error("plain"))).toBe(false);
    expect(isLedgerAccessDenied(null)).toBe(false);
  });

  /**
   * The regression itself. A raw `ZohoError` no longer reaches the money call
   * sites — the adapter wraps it — so a classifier that only understands
   * `ZohoError` returns false for every real lock-out.
   */
  it("does not depend on ZohoError, which the seam no longer lets through", () => {
    const raw = new ZohoError("denied", 6018);
    expect(raw instanceof LedgerError).toBe(false);
    // Wrapped the way lib/ledger/zoho-adapter.ts wraps it, it classifies.
    expect(isLedgerAccessDenied(new LedgerError(raw.message, 6018))).toBe(true);
  });
});

/**
 * Xero's permanent-auth shapes.
 *
 * This module's doc comment promised Xero was covered, because the Xero adapter
 * raises the same `LedgerError` type. Sharing a TYPE is not sharing a SIGNAL:
 * Xero's lock-out arrives as HTTP 400 with no provider code, which is
 * indistinguishable from an ordinary bad request by status alone — so a revoked
 * consent, a refresh token past its 60-day life, or a rotation lost mid-write
 * all classified as TRANSIENT, and the deduped integration alert would never
 * have fired. Each quote would instead have emitted its own "invoice FAILED":
 * five unrelated-looking incidents for one broken integration, none naming the
 * remedy. That is the exact failure this module was written to prevent, one
 * provider over. Nothing pinned it until now.
 */
describe("isLedgerAccessDenied — the Xero lock-out shapes", () => {
  it("recognises a refused grant, which arrives as a plain 400", () => {
    expect(isLedgerAccessDenied(new LedgerError("Xero token request failed: invalid_grant", undefined, 400))).toBe(true);
    expect(isLedgerAccessDenied(new LedgerError("Xero token request failed: invalid_client", undefined, 400))).toBe(true);
  });

  it("recognises a broken rotation and a missing tenant", () => {
    expect(
      isLedgerAccessDenied(
        new LedgerError("Xero returned no new refresh token — the rotation contract was not honoured"),
      ),
    ).toBe(true);
    expect(isLedgerAccessDenied(new LedgerError("No Xero tenant is recorded for this connection."))).toBe(true);
  });

  /**
   * A connection granting two organisations. The refresh itself succeeds — the
   * tenant lookup is what refuses — so it repeats on every pass forever and no
   * retry can resolve it: a human has to re-consent granting exactly one org.
   * That is the same permanent class and the same /api/xero/connect remedy, but
   * it carries no code and no status, so the wording is the only signal.
   */
  it("recognises a connection granting more than one organisation", () => {
    expect(
      isLedgerAccessDenied(
        new LedgerError(
          "This Xero connection grants access to 2 organisations (One Ltd, Two Ltd). " +
            "Refusing to guess which set of books to use — re-authorise and grant exactly one.",
        ),
      ),
    ).toBe(true);
  });

  it("still leaves an ordinary Xero 400 alone", () => {
    // A validation error on one invoice is not an integration outage, and
    // escalating it would train people to ignore the alert that matters.
    expect(isLedgerAccessDenied(new LedgerError("Xero rejected the invoice: account code invalid", undefined, 400))).toBe(
      false,
    );
  });

  /**
   * Never authorised at all — the state every environment starts in.
   *
   * `ledger_tokens` is created empty (migration 0108 seeds nothing, and the
   * prod runbook says "both tables land EMPTY"), so "LEDGER_PROVIDER flipped
   * to xero before an admin went through /api/xero/connect" is not an exotic
   * edge, it is the FIRST state the cutover passes through — and the row can
   * be lost or rebuilt at any time afterwards. It is exactly as permanent as a
   * revoked grant and fixed by exactly the same click, but it carries no
   * provider code and no HTTP status, so the wording is the only signal there
   * is. Classified transient, every invoice raise fails while the books probe
   * reports `alerts: []` every fifteen minutes.
   */
  it("recognises a connection that was never authorised at all", () => {
    expect(
      isLedgerAccessDenied(
        new LedgerError(
          "No xero token row exists — re-authorise at /api/xero/connect (admin only) before using the xero adapter.",
        ),
      ),
    ).toBe(true);
  });

  /**
   * A rotation consumed by Xero but lost before it could be persisted. The
   * refresh token we held is now dead and the replacement went nowhere, so no
   * retry can ever succeed — the store says so in as many words.
   */
  it("recognises a rotation that was consumed but never saved", () => {
    expect(
      isLedgerAccessDenied(
        new LedgerError(
          "The xero refresh token rotated but could not be saved (fetch failed). The integration will need re-authorising.",
        ),
      ),
    ).toBe(true);
  });

  /**
   * The other direction, in the same module and in very similar words. A
   * database blip reading the row, a blip claiming the lease, and the lease
   * wait timing out are all designed to be retried — the next pass claims and
   * refreshes. Escalating them would page a human for a Supabase hiccup and
   * teach the office to ignore the alert that means the books are shut.
   */
  it("still leaves the token store's transient failures alone", () => {
    expect(isLedgerAccessDenied(new LedgerError("Could not read the xero token row: fetch failed"))).toBe(false);
    expect(isLedgerAccessDenied(new LedgerError("Could not claim the xero refresh lease: fetch failed"))).toBe(false);
    expect(
      isLedgerAccessDenied(
        new LedgerError(
          "Timed out waiting for another process to refresh the xero token. " +
            "If this persists, check ledger_tokens.refresh_lease_owner for a stuck lease.",
        ),
      ),
    ).toBe(false);
  });
});

/**
 * Quota exhaustion — integration-wide, and neither of the two classes above.
 *
 * Zoho meters 1,000 API calls per organisation per day and answers a 429 with
 * code 45 once the org has spent them; the staging org hit exactly that. Every
 * invoice raise then fails at once, which is the same BLAST RADIUS as a
 * lock-out — so it must produce one integration-level alarm, not one "invoice
 * FAILED" email per accepted quote. That per-entity shape is the thing the
 * 2026-08-27 decision exists to prevent, and it was reachable again here purely
 * because nothing classified a 429 at all.
 *
 * But it is NOT access denied and must never borrow that remedy. The lock-out
 * copy tells a human to re-enable a user or re-consent; the truthful remedy for
 * a daily quota is to stop what is burning the calls and wait for the reset.
 * Sending the wrong instruction to an office at 2am is worse than sending none,
 * so the two stay separate classifiers with separate wording.
 */
describe("isLedgerRateLimited — its own class, never access-denied", () => {
  it("recognises a quota-exhausted 429 whichever provider raised it", () => {
    expect(
      isLedgerRateLimited(
        new LedgerError("You have exceeded the maximum call rate limit of 1,000 API calls", 45, 429),
      ),
    ).toBe(true);
    expect(isLedgerRateLimited(new LedgerError("Xero invoice create failed: rate limited — retry after 37s (…)", undefined, 429))).toBe(
      true,
    );
  });

  /**
   * Zoho puts a non-zero `code` in the BODY of some 200s, so the status alone
   * is not the whole signal — the client raises those with the HTTP status it
   * actually got. The provider's own wording is the second, independent signal.
   */
  it("recognises the provider's own wording even without the status", () => {
    expect(
      isLedgerRateLimited(new LedgerError("You have exceeded the maximum call rate limit of 1,000 API calls", 45, 200)),
    ).toBe(true);
  });

  it("leaves ordinary failures alone", () => {
    expect(isLedgerRateLimited(new LedgerError("Xero rejected the invoice: account code invalid", undefined, 400))).toBe(
      false,
    );
    expect(isLedgerRateLimited(new LedgerError("gateway timeout", undefined, 504))).toBe(false);
    expect(isLedgerRateLimited(new Error("plain"))).toBe(false);
    expect(isLedgerRateLimited(null)).toBe(false);
  });

  /**
   * The half that must never drift. A quota resets on its own, so classifying
   * it permanent would put "a Zoho admin marks the ops user Active again" in
   * front of an office whose user was never disabled — an alarm that names the
   * wrong remedy is worse than the per-quote noise it replaced.
   */
  it("a rate limit is not a lock-out, in either direction", () => {
    const quota = new LedgerError("You have exceeded the maximum call rate limit of 1,000 API calls", 45, 429);
    expect(isLedgerAccessDenied(quota)).toBe(false);
    const lockout = new LedgerError("denied", 6018);
    expect(isLedgerRateLimited(lockout)).toBe(false);
  });
});

/**
 * The class guard, covering the three raise paths no behavioural test reaches.
 * A future edit reintroducing the ZohoError-only check would pass every test
 * above and still stop escalating lock-outs on invoice creation.
 */
describe("the money call sites classify through the seam", () => {
  it("accept-flow never imports the ZohoError-only classifier", () => {
    // Comments are stripped first: this file's own explanation of the trap
    // names the forbidden function, and a mention is not a call. Same rule as
    // tests/lib/security/api-route-guards.test.ts, which was written after
    // scanning raw source flagged an already-fixed route as still broken.
    const src = readFileSync(join(__dirname, "../../../lib/quote/accept-flow.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    expect(src).toContain("isLedgerAccessDenied");
    expect(
      src.includes("isZohoAccessDenied"),
      "accept-flow errors arrive as LedgerError since gate 17, so isZohoAccessDenied " +
        "returns false for every one of them — use isLedgerAccessDenied",
    ).toBe(false);
  });

  /**
   * A classifier with no caller raises no alarm.
   *
   * `isLedgerRateLimited` shipped ahead of its wiring, so a quota that stops all
   * billing still reached the everything-else branch: one per-quote email per
   * accepted quote, none of them naming the cause. Counted rather than eyeballed
   * because the three raise catches are near-identical and the fourth rail added
   * beside them will look exactly the same.
   */
  it("routes a rate limit to its own alarm on every raise path the lock-out covers", () => {
    const src = readFileSync(join(__dirname, "../../../lib/quote/accept-flow.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const count = (needle: string) => src.split(needle).length - 1;
    const lockout = count('reportLedgerAccessDenied(sb, { provider: ledger, message: msg, while: "');
    const quota = count('reportLedgerRateLimited(sb, { provider: ledger, message: msg, while: "');
    expect(lockout).toBe(3); // deposit, commitment, balance
    expect(
      quota,
      `${lockout} raise path(s) escalate a lock-out but only ${quota} escalate a quota. ` +
        `An unwired rate-limit branch means every accepted quote emails its own "invoice FAILED" ` +
        `while the books are refusing all of them for one reason.`,
    ).toBe(lockout);
  });

  /**
   * Every read or write against a STORED invoice id must carry the provider that
   * minted it. Three `recordInvoicePayment` calls and two `getInvoicePdfBase64`
   * calls were missing it, each sitting directly beneath a `getInvoiceStatus`
   * that passed it correctly — so the omission was invisible by eye.
   *
   * After the flip, an un-stamped call sends a Zoho id to Xero: the payment
   * write fails and the deposit is marked paid in ops while appearing in neither
   * set of books, and the PDF read fails silently so a customer asking "where do
   * I pay?" gets a second email with no invoice attached.
   *
   * Counted rather than eyeballed, because the next raise path added will sit
   * beside these and look exactly like them.
   */
  it("passes the provider stamp on every stored-id ledger call", () => {
    const src = readFileSync(join(__dirname, "../../../lib/quote/accept-flow.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    for (const fn of ["recordInvoicePayment", "getInvoicePdfBase64", "getInvoiceStatus", "voidInvoice"]) {
      const calls = src.split(new RegExp(String.raw`\b${fn}\s*\(`)).length - 1;
      const stamped =
        src.split(new RegExp(String.raw`\b${fn}\s*\([\s\S]{0,400}?asProvider\(`)).length - 1;
      expect(
        stamped,
        `${fn}: ${calls} call(s) but only ${stamped} pass asProvider(...). A stored invoice id ` +
          `belongs to the ledger that minted it; routing it by the CONFIGURED provider breaks ` +
          `every pre-cutover document the moment LEDGER_PROVIDER flips.`,
      ).toBe(calls);
    }
  });
});
