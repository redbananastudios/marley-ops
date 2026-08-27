import { describe, expect, it } from "vitest";
import { ZohoError, isZohoAccessDenied } from "@/lib/zoho";
import { zohoAccessAlert } from "@/lib/watchdog-rules";

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

describe("zohoAccessAlert", () => {
  it("reachable → silent", () => {
    expect(zohoAccessAlert({ ok: true })).toBeNull();
  });

  it("unreachable but transient → silent (it clears on the next pass)", () => {
    expect(zohoAccessAlert({ ok: false, accessDenied: false })).toBeNull();
  });

  it("locked out → alerts, and says what to actually do", () => {
    const alert = zohoAccessAlert({ ok: false, accessDenied: true });
    expect(alert?.key).toBe("zoho-access");
    expect(alert?.message).toContain("Re-enable the ops user in Zoho");
  });
});
