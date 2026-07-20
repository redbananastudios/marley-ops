import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailPayloadHash, sendEmail, sendSms } from "@/lib/comms/send";

describe("provider delivery safety", () => {
  beforeEach(() => {
    process.env.MARLEY_RESEND_API_KEY = "test-resend-key";
    process.env.WEBEX_API_KEY = "test-webex-key";
    process.env.WEBEX_SMS_SENDER_MARLEY_MOVES = "Marley";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes the stable logical-send key to Resend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "email-1" }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendEmail({
      to: "customer@example.com",
      subject: "Quote",
      html: "<p>Hello</p>",
      idempotencyKey: "marley-comm/abc",
    });
    expect(result).toEqual({ ok: true, providerId: "email-1" });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "Idempotency-Key": "marley-comm/abc" });
  });

  it("fingerprints the exact Resend payload while excluding the retry key", () => {
    const base = {
      to: "customer@example.com",
      subject: "Quote",
      html: "<p>Hello</p>",
      attachments: [{ filename: "quote.pdf", content: "cGRmLTE=" }],
      replyTo: "reply@example.com",
      from: "Marley Moves <hello@marleymoves.co.uk>",
    };
    expect(emailPayloadHash({ ...base, idempotencyKey: "attempt-1" }))
      .toBe(emailPayloadHash({ ...base, idempotencyKey: "attempt-2" }));
    expect(emailPayloadHash(base)).not.toBe(emailPayloadHash({
      ...base,
      attachments: [{ filename: "quote.pdf", content: "cGRmLTI=" }],
    }));
    expect(emailPayloadHash(base)).not.toBe(emailPayloadHash({ ...base, html: "<p>Changed</p>" }));
  });

  it("marks transport exceptions as outcome-unknown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket reset")));
    await expect(sendEmail({ to: "a@b.test", subject: "x", html: "x", idempotencyKey: "k" }))
      .resolves.toMatchObject({ ok: false, outcomeUnknown: true });
    await expect(sendSms({ to: "07000000000", body: "x" }))
      .resolves.toMatchObject({ ok: false, outcomeUnknown: true });
  });
});
