import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendEmail, sendEmailViaSmtpFallback, smtpFallbackConfigured, shouldSmtpFallback } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendEmailViaSmtpFallback: vi.fn(),
  smtpFallbackConfigured: vi.fn(() => false),
  shouldSmtpFallback: vi.fn(() => false),
}));
vi.mock("@/lib/comms/send", () => ({
  sendEmail,
  sendEmailViaSmtpFallback,
  smtpFallbackConfigured,
  shouldSmtpFallback,
}));
vi.mock("@/lib/comms/sender", () => ({ opsAlertRecipient: () => "ops@example.test" }));

import { deliverDailyOperationalIssueDigest } from "@/lib/ops/issues";

const issue = {
  issue_key: "cron:chase",
  severity: "error",
  message: "Scheduled job chase failed.",
  occurrence_count: 2,
  last_seen_at: "2026-07-20T08:00:00Z",
};

function digestClient(decision = "claimed", totalCount = 1) {
  const payload = { issues: [issue], totalCount, omittedCount: totalCount - 1 };
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_operational_issue_digest") {
      return {
        data: [{
          decision,
          digest_claim_token: decision === "claimed" ? "11111111-1111-4111-8111-111111111111" : null,
          digest_payload: payload,
          digest_issue_count: totalCount,
          digest_attempt_count: 1,
        }],
        error: null,
      };
    }
    return { data: true, error: null };
  });
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        order: () => ({ limit: () => Promise.resolve({ data: [issue], count: totalCount, error: null }) }),
      }),
    }),
  }));
  return { client: { from, rpc } as never, rpc };
}

describe("daily operational issue digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    smtpFallbackConfigured.mockReturnValue(false);
    shouldSmtpFallback.mockReturnValue(false);
  });

  it("atomically claims, sends a frozen payload, and records success", async () => {
    sendEmail.mockResolvedValue({ ok: true, providerId: "email-1" });
    const fake = digestClient("claimed", 72);
    const result = await deliverDailyOperationalIssueDigest(fake.client, new Date("2026-07-20T12:00:00Z"));
    expect(result).toBe("sent");
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "ops@example.test",
      subject: expect.stringContaining("72 open"),
      html: expect.stringContaining("Plus 71 more open issues."),
      // Day + payload-hash scoped: identical retries dedupe at the provider,
      // a changed payload is never rejected as a modified-body key reuse.
      idempotencyKey: expect.stringMatching(/^marley-ops-daily\/2026-07-20\/[a-f0-9]{16}$/),
    }));
    expect(fake.rpc).toHaveBeenCalledWith("claim_operational_issue_digest", expect.objectContaining({
      p_issue_count: 72,
      p_payload_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(fake.rpc).toHaveBeenCalledWith("complete_operational_issue_digest", expect.any(Object));
  });

  it("does not send while another worker owns the digest", async () => {
    const fake = digestClient("busy");
    await expect(deliverDailyOperationalIssueDigest(fake.client, new Date("2026-07-20T12:00:00Z")))
      .resolves.toBe("already-sent");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("records a failed provider attempt for a retry", async () => {
    sendEmail.mockResolvedValue({ ok: false, error: "provider unavailable" });
    const fake = digestClient();
    await expect(deliverDailyOperationalIssueDigest(fake.client, new Date("2026-07-20T12:00:00Z")))
      .resolves.toBe("failed");
    expect(fake.rpc).toHaveBeenCalledWith("fail_operational_issue_digest", expect.objectContaining({
      p_error: "provider unavailable",
    }));
    expect(fake.rpc).toHaveBeenCalledWith("report_operational_issue", expect.any(Object));
  });

  it("falls back to SMTP when Resend is the thing that is down", async () => {
    // The digest is the surface that would carry a "Resend is failing" notice,
    // so it must not itself die with Resend. Guarded the same way as customer
    // mail: only when Resend definitively did not send.
    sendEmail.mockResolvedValue({ ok: false, error: "Resend error 401", status: 401 });
    smtpFallbackConfigured.mockReturnValue(true);
    shouldSmtpFallback.mockReturnValue(true);
    sendEmailViaSmtpFallback.mockResolvedValue({ ok: true, providerId: "smtp-1" });

    const fake = digestClient();
    await expect(deliverDailyOperationalIssueDigest(fake.client, new Date("2026-07-20T12:00:00Z")))
      .resolves.toBe("sent");
    expect(sendEmailViaSmtpFallback).toHaveBeenCalledTimes(1);
    // Same payload as the Resend attempt — no second, differently-keyed message.
    expect(sendEmailViaSmtpFallback).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^marley-ops-daily\/2026-07-20\//) }),
    );
  });

  it("does not reach for SMTP when the fallback is not configured", async () => {
    sendEmail.mockResolvedValue({ ok: false, error: "provider unavailable" });
    smtpFallbackConfigured.mockReturnValue(false);
    shouldSmtpFallback.mockReturnValue(true);
    const fake = digestClient();
    await expect(deliverDailyOperationalIssueDigest(fake.client, new Date("2026-07-20T12:00:00Z")))
      .resolves.toBe("failed");
    expect(sendEmailViaSmtpFallback).not.toHaveBeenCalled();
  });

  it("records dry-run delivery as simulated, not sent", async () => {
    sendEmail.mockResolvedValue({ ok: true, providerId: "dryrun-email-1", simulated: true });
    const fake = digestClient();
    await expect(deliverDailyOperationalIssueDigest(fake.client, new Date("2026-07-20T12:00:00Z")))
      .resolves.toBe("simulated");
    expect(fake.rpc).toHaveBeenCalledWith("simulate_operational_issue_digest", expect.any(Object));
    expect(fake.rpc).not.toHaveBeenCalledWith("complete_operational_issue_digest", expect.any(Object));
  });
});
