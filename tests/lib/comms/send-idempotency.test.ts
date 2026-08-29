import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailPayloadHash, sendEmail, sendSms, smsSenderFor } from "@/lib/comms/send";

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

  it("smsSenderFor: a non-default brand NEVER borrows the default brand's sender id (trap 7)", () => {
    // beforeEach seeds WEBEX_SMS_SENDER_MARLEY_MOVES = "Marley"
    expect(smsSenderFor()).toBe("Marley");
    expect(smsSenderFor(null)).toBe("Marley");
    expect(smsSenderFor({ slug: "marley", smsSender: "NeverUsed" })).toBe("Marley");
    expect(smsSenderFor({ slug: "pitmans", smsSender: "Pitmans" })).toBe("Pitmans");
    // This assertion used to read .toBe("Marley"), with a comment calling the
    // fallback intended. It was the defect written down as a spec: the body says
    // one brand and the handset says another, on a money chase, and the reply
    // routes to a rail with no record of the customer (QA-20260826-08).
    expect(smsSenderFor({ slug: "pitmans", smsSender: null })).toBeUndefined();
    expect(smsSenderFor({ slug: "pitmans", smsSender: "" })).toBeUndefined();
    // Group comms keep the operating company's identity, so the group
    // pseudo-brand must NOT be refused. Unlike templateIdFor, where an absent
    // template degrades to inline HTML, a refusal here stops the send outright.
    expect(smsSenderFor({ slug: "group", smsSender: null })).toBe("Marley");
  });

  it("a brand with no sender id refuses the send loudly rather than sending as another brand", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await sendSms({ to: "07000000000", body: "x", brand: { slug: "pitmans", smsSender: null } });
    expect(res.ok).toBe(false);
    // The message names the column to set, not an env var that is already fine.
    expect(res.error).toContain("pitmans");
    expect(res.error).toContain("brands.sms_sender");
    // And the remedy it names must actually release THIS row. The comms-retry
    // worker re-reads brands.sms_sender before re-driving an SMS, so setting the
    // column sends the held message; without that re-read the retry would replay
    // the frozen snapshot and this sentence would be a lie.
    expect(res.error).toContain("next retry");
    // Nothing left the process, and the outcome is DEFINITE - a failed row that
    // will not be re-driven as outcome-unknown.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.outcomeUnknown).toBeFalsy();
  });

  it("a branded sendSms puts the brand sender on the wire; unbranded stays byte-identical", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ transaction_id: "t1" }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await sendSms({ to: "07000000000", body: "x", brand: { slug: "pitmans", smsSender: "Pitmans" } });
    await sendSms({ to: "07000000000", body: "x" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).from).toBe("Pitmans");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).from).toBe("Marley");
  });
});

describe("in-process email retry (idempotency-safe)", () => {
  beforeEach(() => {
    process.env.MARLEY_RESEND_API_KEY = "test-resend-key";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const ok = (id: string) => ({ ok: true, json: async () => ({ id }) });
  const httpErr = (status: number, message: string) => ({ ok: false, status, json: async () => ({ message }) });

  it("retries a transient 5xx and then succeeds on the reused key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpErr(503, "upstream busy"))
      .mockResolvedValueOnce(ok("email-2"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendEmail({ to: "c@example.com", subject: "s", html: "<p>x</p>", idempotencyKey: "marley-comm/1" });
    expect(result).toEqual({ ok: true, providerId: "email-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Every attempt reuses the SAME idempotency key, so Resend can't double-send.
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe("marley-comm/1");
    expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).toBe("marley-comm/1");
  });

  it("recovers from a timeout exception (the real stranded-chase case)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"))
      .mockResolvedValueOnce(ok("email-after-timeout"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendEmail({ to: "c@example.com", subject: "s", html: "<p>x</p>", idempotencyKey: "marley-comm/2" });
    expect(result).toEqual({ ok: true, providerId: "email-after-timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a definite reject (4xx) — retrying a bad address is pointless", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpErr(422, "invalid to address"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendEmail({ to: "bad", subject: "s", html: "<p>x</p>", idempotencyKey: "marley-comm/3" });
    expect(result).toMatchObject({ ok: false, outcomeUnknown: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when there is no idempotency key — a retry could double-send", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpErr(500, "boom"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendEmail({ to: "c@example.com", subject: "s", html: "<p>x</p>" });
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 attempts on a persistent unknown outcome", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket reset"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendEmail({ to: "c@example.com", subject: "s", html: "<p>x</p>", idempotencyKey: "marley-comm/4" });
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
