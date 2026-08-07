import { describe, expect, it } from "vitest";
import {
  emailPayloadHash,
  shouldRetryResendAttempt,
  shouldSmtpFallback,
  type SendResult,
} from "@/lib/comms/send";

const fail = (over: Partial<SendResult>): SendResult => ({ ok: false, error: "x", ...over });

/**
 * The SMTP fallback exists for PROVIDER outages, never payload problems, and
 * never where a double-send is unmitigated. The classifier is pure so this
 * reasoning stays locked:
 *  - account-level rejects (401/403/429): Resend definitively did not send.
 *  - outcomeUnknown WITH an idempotency key: keyed retries make a silent
 *    prior success vanishingly unlikely.
 *  - outcomeUnknown WITHOUT a key: no mitigation — never fall back.
 *  - payload rejects (400/422): the content is the problem, not the pipe.
 */
describe("shouldSmtpFallback", () => {
  it("falls back on Resend account-level rejects regardless of idempotency", () => {
    for (const status of [401, 403, 429]) {
      expect(shouldSmtpFallback(fail({ status }), true)).toBe(true);
      expect(shouldSmtpFallback(fail({ status }), false)).toBe(true);
    }
  });

  it("falls back on outcome-unknown ONLY when the send was idempotency-keyed", () => {
    expect(shouldSmtpFallback(fail({ outcomeUnknown: true, status: 500 }), true)).toBe(true);
    expect(shouldSmtpFallback(fail({ outcomeUnknown: true, status: 500 }), false)).toBe(false);
    expect(shouldSmtpFallback(fail({ outcomeUnknown: true }), true)).toBe(true); // network error, no status
  });

  it("never falls back on payload rejects or successes", () => {
    expect(shouldSmtpFallback(fail({ status: 400 }), true)).toBe(false);
    expect(shouldSmtpFallback(fail({ status: 422 }), true)).toBe(false);
    expect(shouldSmtpFallback({ ok: true }, true)).toBe(false);
  });
});

/**
 * In-process retry gate. 429 is normally Resend's per-second rate limit (a
 * burst from the chase cron trips it routinely) — it must RETRY, not divert a
 * healthy-provider send to the degraded SMTP path. Outcome-unknown retries
 * are only safe under an idempotency key.
 */
describe("shouldRetryResendAttempt", () => {
  it("429 retries in-process regardless of idempotency (nothing was sent)", () => {
    expect(shouldRetryResendAttempt(fail({ status: 429 }), true)).toBe(true);
    expect(shouldRetryResendAttempt(fail({ status: 429 }), false)).toBe(true);
  });

  it("outcome-unknown retries only under an idempotency key", () => {
    expect(shouldRetryResendAttempt(fail({ outcomeUnknown: true, status: 500 }), true)).toBe(true);
    expect(shouldRetryResendAttempt(fail({ outcomeUnknown: true, status: 500 }), false)).toBe(false);
  });

  it("definite rejects and successes never retry", () => {
    expect(shouldRetryResendAttempt(fail({ status: 400 }), true)).toBe(false);
    expect(shouldRetryResendAttempt(fail({ status: 401 }), true)).toBe(false);
    expect(shouldRetryResendAttempt({ ok: true }, true)).toBe(false);
  });
});

describe("emailPayloadHash ignores fallbackHtml", () => {
  it("the same logical template send hashes identically with and without the carried fallback body", () => {
    const base = {
      to: "jane@example.com",
      subject: "Your removal quote from Marley Moves — MMR001",
      template: { id: "tpl_1", variables: { QUOTE_REF: "MMR001" } },
    };
    expect(emailPayloadHash(base)).toBe(emailPayloadHash({ ...base, fallbackHtml: "<p>huge rendered body</p>" }));
  });
});
