import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LedgerError } from "@/lib/ledger";
import { isLedgerAccessDenied } from "@/lib/ledger/access";
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
});
