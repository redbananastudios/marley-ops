import { describe, expect, it } from "vitest";
import { ZohoError, isZohoAccessDenied, isZohoRateLimited } from "@/lib/zoho";
import { ledgerAccessAlert } from "@/lib/watchdog-rules";

/**
 * 2026-08-27: Zoho deactivated the org user behind the ops refresh token. OAuth
 * kept issuing access tokens, `GET /organizations` kept answering, and every
 * org-scoped call returned code 6018. Nothing in ops noticed for hours. These
 * tests pin the line between "retry quietly" and "wake a human".
 */
describe("isZohoAccessDenied", () => {
  it("6018 (account disabled) is a lock-out", () => {
    const err = new ZohoError(
      "You do not have access as your account is disabled. Please contact your administrator for details.",
      6018,
      200,
    );
    expect(isZohoAccessDenied(err)).toBe(true);
  });

  it("57 (not authorized) and bare 401/403 are lock-outs", () => {
    expect(isZohoAccessDenied(new ZohoError("You are not authorized", 57, 200))).toBe(true);
    expect(isZohoAccessDenied(new ZohoError("Zoho error 401", undefined, 401))).toBe(true);
    expect(isZohoAccessDenied(new ZohoError("Zoho error 403", undefined, 403))).toBe(true);
  });

  it("a dropped credential is a lock-out, not a blip — the alarm must not depend on the config it watches", () => {
    expect(isZohoAccessDenied(new ZohoError("Zoho credentials not configured (ZOHO_* env vars)"))).toBe(true);
    expect(isZohoAccessDenied(new ZohoError("Zoho token refresh failed: invalid_grant", undefined, 400))).toBe(true);
  });

  it("transient failures are NOT lock-outs — they must keep retrying silently", () => {
    expect(isZohoAccessDenied(new ZohoError("Zoho error 500", undefined, 500))).toBe(false);
    expect(isZohoAccessDenied(new ZohoError("Zoho error 429", undefined, 429))).toBe(false);
    expect(isZohoAccessDenied(new ZohoError("Invalid URL Passed", 5, 200))).toBe(false);
    expect(isZohoAccessDenied(new Error("fetch failed"))).toBe(false);
    expect(isZohoAccessDenied(new DOMException("timed out", "TimeoutError"))).toBe(false);
  });
});

/**
 * The watchdog's own half of the quota classification. `checkZohoAccess` builds
 * its verdict from raw `ZohoError`s — the seam's `isLedgerRateLimited` opens by
 * rejecting anything that is not a `LedgerError`, so it cannot answer here — and
 * a verdict with no rate-limit signal leaves the 15-minute probe reporting
 * `{ok: false, accessDenied: false}`, which the rules read as a blip and say
 * nothing about. A quota that stops all billing for a day is not a blip.
 */
describe("isZohoRateLimited", () => {
  it("recognises the 429 the org answers with once its daily allowance is spent", () => {
    expect(
      isZohoRateLimited(
        new ZohoError(
          "The API call for this organisation has exceeded the maximum call rate limit of 1,000",
          45,
          429,
        ),
      ),
    ).toBe(true);
  });

  it("recognises the wording even when it arrives under a 200, as Zoho body codes do", () => {
    expect(
      isZohoRateLimited(new ZohoError("You have exceeded the maximum call rate limit", 45, 200)),
    ).toBe(true);
  });

  it("is not the lock-out test, in either direction", () => {
    const quota = new ZohoError("exceeded the maximum call rate limit of 1,000", 45, 429);
    expect(isZohoAccessDenied(quota)).toBe(false);
    expect(isZohoRateLimited(new ZohoError("You do not have access", 6018, 200))).toBe(false);
  });

  it("leaves ordinary failures alone", () => {
    expect(isZohoRateLimited(new ZohoError("Zoho error 500", undefined, 500))).toBe(false);
    expect(isZohoRateLimited(new Error("fetch failed"))).toBe(false);
    expect(isZohoRateLimited(null)).toBe(false);
  });
});

describe("ledgerAccessAlert", () => {
  it("reachable → silent, for either provider", () => {
    expect(ledgerAccessAlert("zoho", { ok: true })).toBeNull();
    expect(ledgerAccessAlert("xero", { ok: true })).toBeNull();
  });

  it("unreachable but transient → silent (it clears on the next pass)", () => {
    expect(ledgerAccessAlert("zoho", { ok: false, accessDenied: false })).toBeNull();
    expect(ledgerAccessAlert("xero", { ok: false, accessDenied: false })).toBeNull();
  });

  it("zoho locked out → the alert the 2026-08-27 fix shipped, byte-identical", () => {
    const alert = ledgerAccessAlert("zoho", { ok: false, accessDenied: true });
    expect(alert).toEqual({
      key: "zoho-access",
      message:
        "Zoho is refusing the ops integration — no invoices are being raised. Re-enable the ops user in Zoho",
    });
  });

  it("xero locked out → its OWN key and its OWN remedy, never Zoho's", () => {
    const alert = ledgerAccessAlert("xero", { ok: false, accessDenied: true });
    expect(alert?.key).toBe("xero-access");
    expect(alert?.message).toContain("Xero");
    expect(alert?.message).toContain("/api/xero/connect");
    expect(alert?.message).not.toMatch(/zoho/i);
  });

  /**
   * A spent quota refuses every call for the rest of the day, so the probe must
   * page — but under its own key and with its own words. Sharing the lock-out
   * key would let one clear the other's cooldown, and sharing the lock-out
   * wording would send the office to a user screen where nothing is wrong.
   */
  it("a spent quota alerts under its own key, with none of the lock-out remedy", () => {
    for (const provider of ["zoho", "xero"] as const) {
      const alert = ledgerAccessAlert(provider, { ok: false, accessDenied: false, rateLimited: true });
      expect(alert?.key).toBe(`${provider}-rate-limit`);
      expect(alert!.key).not.toBe(`${provider}-access`);
      expect(alert!.message).toMatch(new RegExp(provider, "i"));
      expect(alert!.message).not.toMatch(/re-enable|re-authoris|\/api\/xero\/connect/i);
    }
  });

  it("still says nothing for a transient failure that carries neither signal", () => {
    expect(ledgerAccessAlert("zoho", { ok: false, accessDenied: false, rateLimited: false })).toBeNull();
  });
});
