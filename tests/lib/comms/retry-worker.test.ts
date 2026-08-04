import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the shared send path + issue reporter so we test the worker's ORCHESTRATION
// (which rows it re-drives, backs off, caps, escalates) — not the provider call.
const { runProviderSend, sendOpsAlert, reportOperationalIssue, resolveOperationalIssue } = vi.hoisted(() => ({
  runProviderSend: vi.fn(),
  sendOpsAlert: vi.fn(),
  reportOperationalIssue: vi.fn(),
  resolveOperationalIssue: vi.fn(),
}));
vi.mock("@/lib/comms/dispatch", () => ({ runProviderSend, sendOpsAlert }));
vi.mock("@/lib/ops/issues", () => ({ reportOperationalIssue, resolveOperationalIssue }));

import {
  runCommsRetry,
  escalateUnretryableComms,
  commsRetryBackoffMs,
  commsRetryDue,
  COMMS_RETRY_MAX_ATTEMPTS,
  COMMS_RECLAIM_WINDOW_HOURS,
} from "@/lib/comms/retry-worker";

const nowMs = 1_700_000_000_000;
const NOW = new Date(nowMs);

const row = (o: Record<string, unknown> = {}) => ({
  id: "c1",
  channel: "email",
  to_address: "c@example.com",
  subject: "Your quote",
  lead_id: "L1",
  client_id: null,
  claim_token: "old-token",
  attempt_count: 1,
  provider_payload_hash: "hash",
  provider_request: { channel: "email", email: { to: "c@example.com", subject: "Your quote", html: "<p>x</p>" } },
  content_hash: "ch",
  updated_at: new Date(nowMs - 10 * 60_000).toISOString(), // 10m ago → due at attempt 1
  ...o,
});

/** Minimal Supabase double for exactly the calls runCommsRetry makes. */
function fakeSb(opts: { rows: unknown[]; reclaim: boolean; afterAttempt: number }) {
  const reclaimCalls: unknown[] = [];
  const sb = {
    from() {
      return {
        select(cols: string) {
          if (cols === "attempt_count") {
            return {
              eq: () => ({ maybeSingle: async () => ({ data: { attempt_count: opts.afterAttempt } }) }),
            };
          }
          const b: Record<string, unknown> = {};
          for (const m of ["eq", "not", "lt", "order", "limit"]) b[m] = () => b;
          b.then = (resolve: (v: unknown) => unknown) => resolve({ data: opts.rows, error: null });
          return b;
        },
      };
    },
    async rpc(name: string, args: unknown) {
      if (name === "reclaim_communication_send") {
        reclaimCalls.push(args);
        return { data: opts.reclaim };
      }
      return { data: null };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sb: sb as any, reclaimCalls };
}

describe("commsRetryBackoffMs", () => {
  it("grows with attempt_count and caps at 60 minutes", () => {
    expect(commsRetryBackoffMs(1)).toBe(5 * 60_000);
    expect(commsRetryBackoffMs(6)).toBe(30 * 60_000);
    expect(commsRetryBackoffMs(12)).toBe(60 * 60_000);
    expect(commsRetryBackoffMs(1000)).toBe(60 * 60_000);
    expect(commsRetryBackoffMs(0)).toBe(5 * 60_000); // floors at 1
  });
});

describe("commsRetryDue", () => {
  it("is due only once the backoff has elapsed", () => {
    expect(commsRetryDue({ attempt_count: 1, updated_at: new Date(nowMs - 5 * 60_000).toISOString() }, nowMs)).toBe(true);
    expect(commsRetryDue({ attempt_count: 1, updated_at: new Date(nowMs - 4 * 60_000).toISOString() }, nowMs)).toBe(false);
    // higher attempt_count means a longer wait
    expect(commsRetryDue({ attempt_count: 6, updated_at: new Date(nowMs - 20 * 60_000).toISOString() }, nowMs)).toBe(false);
    expect(commsRetryDue({ attempt_count: 6, updated_at: new Date(nowMs - 31 * 60_000).toISOString() }, nowMs)).toBe(true);
  });
});

describe("runCommsRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-drives a due failed row and counts the recovery (same id, fresh token, retried flag)", async () => {
    runProviderSend.mockResolvedValue({ ok: true });
    const { sb, reclaimCalls } = fakeSb({ rows: [row()], reclaim: true, afterAttempt: 2 });
    const s = await runCommsRetry(sb, NOW);
    expect(s).toMatchObject({ candidates: 1, redriven: 1, recovered: 1, waiting: 0, escalated: 0 });
    expect(reclaimCalls).toHaveLength(1);
    expect(runProviderSend).toHaveBeenCalledTimes(1);
    expect(runProviderSend.mock.calls[0][2]).toMatchObject({ communicationId: "c1", retried: true });
    // A fresh claim token is minted (never the stored one) so we never race finalisation.
    expect((reclaimCalls[0] as { p_new_claim_token: string }).p_new_claim_token).not.toBe("old-token");
  });

  it("waits (no re-drive) when the backoff has not elapsed", async () => {
    const { sb } = fakeSb({ rows: [row({ updated_at: new Date(nowMs - 60_000).toISOString() })], reclaim: true, afterAttempt: 2 });
    const s = await runCommsRetry(sb, NOW);
    expect(s).toMatchObject({ redriven: 0, waiting: 1, recovered: 0 });
    expect(runProviderSend).not.toHaveBeenCalled();
  });

  it("leaves a row alone when reclaim refuses it (outside the duplicate-safe window)", async () => {
    const { sb } = fakeSb({ rows: [row()], reclaim: false, afterAttempt: 2 });
    const s = await runCommsRetry(sb, NOW);
    expect(s).toMatchObject({ redriven: 0, waiting: 1, recovered: 0 });
    expect(runProviderSend).not.toHaveBeenCalled();
  });

  it("escalates ONCE when a re-drive fails and hits the attempt ceiling", async () => {
    runProviderSend.mockResolvedValue({ ok: false, error: "provider still down" });
    const oldEnough = new Date(nowMs - 120 * 60_000).toISOString(); // past even the 60m cap
    const { sb } = fakeSb({ rows: [row({ attempt_count: COMMS_RETRY_MAX_ATTEMPTS - 1, updated_at: oldEnough })], reclaim: true, afterAttempt: COMMS_RETRY_MAX_ATTEMPTS });
    const s = await runCommsRetry(sb, NOW);
    expect(s).toMatchObject({ redriven: 1, recovered: 0, escalated: 1 });
    expect(reportOperationalIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: "critical", event: "comm.retry.exhausted" }),
    );
  });

  it("does NOT escalate a failed re-drive that still has attempts left", async () => {
    runProviderSend.mockResolvedValue({ ok: false, error: "transient" });
    const oldEnough = new Date(nowMs - 120 * 60_000).toISOString();
    const { sb } = fakeSb({ rows: [row({ attempt_count: 3, updated_at: oldEnough })], reclaim: true, afterAttempt: 4 });
    const s = await runCommsRetry(sb, NOW);
    expect(s).toMatchObject({ redriven: 1, recovered: 0, escalated: 0 });
    expect(reportOperationalIssue).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------- backstop: un-retryable rows */

const unRow = (o: Record<string, unknown> = {}) => ({
  id: "u1",
  channel: "email",
  to_address: "m@example.com",
  subject: "One last step to secure your booking",
  provider_request: null, // no stored payload → un-retryable
  provider_outcome_unknown: true, // a timeout — outcome genuinely unknown
  provider_started_at: new Date(nowMs - 26 * 60 * 60_000).toISOString(),
  created_at: new Date(nowMs - 26 * 60 * 60_000).toISOString(),
  attempt_count: 1,
  ...o,
});

/** Supabase double for the exact calls escalateUnretryableComms makes: the
 *  communications sweep (awaited via then), the per-row open-issue lookup
 *  (maybeSingle), and the attempt_count cap (update().eq().eq()). */
function fakeUnretryableSb(rows: unknown[], opts: { openIssue?: boolean } = {}) {
  const openIssue = opts.openIssue ?? true;
  const updates: unknown[] = [];
  const sb = {
    from() {
      return {
        select() {
          const b: Record<string, unknown> = {};
          for (const m of ["eq", "lt", "or", "order", "limit"]) b[m] = () => b;
          b.maybeSingle = () => Promise.resolve({ data: openIssue ? { id: "iss" } : null });
          b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
          return b;
        },
        update(patch: unknown) {
          return { eq: () => ({ eq: () => { updates.push(patch); return Promise.resolve({ data: null, error: null }); } }) };
        },
      };
    },
    async rpc() {
      return { data: null };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sb: sb as any, updates };
}

describe("escalateUnretryableComms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendOpsAlert.mockResolvedValue(true);
  });

  it("notifies once, resolves the issue, and caps a payload-less failed row", async () => {
    const { sb, updates } = fakeUnretryableSb([unRow()]);
    const s = await escalateUnretryableComms(sb, NOW);
    expect(s).toEqual({ stranded: 1 });
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    // system-category, single-fire idempotency key scoped to the row.
    expect(sendOpsAlert.mock.calls[0][2]).toBe("system");
    expect(sendOpsAlert.mock.calls[0][3]).toBe("comm-unretryable/u1");
    expect(resolveOperationalIssue).toHaveBeenCalledWith(expect.anything(), "communication:u1");
    expect(updates).toEqual([{ attempt_count: COMMS_RETRY_MAX_ATTEMPTS }]);
  });

  it("links the lead when the row has one, and omits the line when it doesn't", async () => {
    const linked = fakeUnretryableSb([unRow({ lead_id: "lead-9" })]);
    await escalateUnretryableComms(linked.sb, NOW);
    expect((sendOpsAlert.mock.calls[0][1] as string[]).join(" ")).toContain("/leads/lead-9");

    vi.clearAllMocks();
    sendOpsAlert.mockResolvedValue(true);
    const bare = fakeUnretryableSb([unRow()]);
    await escalateUnretryableComms(bare.sb, NOW);
    expect((sendOpsAlert.mock.calls[0][1] as string[]).join(" ")).not.toContain("/leads/");
  });

  it("handles a past-window row that still has its payload (reclaim would refuse it)", async () => {
    const stale = new Date(nowMs - (COMMS_RECLAIM_WINDOW_HOURS + 1) * 60 * 60_000).toISOString();
    const { sb } = fakeUnretryableSb([
      unRow({ id: "u2", provider_request: { channel: "email", email: { to: "m@example.com" } }, provider_started_at: stale }),
    ]);
    const s = await escalateUnretryableComms(sb, NOW);
    expect(s).toEqual({ stranded: 1 });
    expect(resolveOperationalIssue).toHaveBeenCalledWith(expect.anything(), "communication:u2");
  });

  it("skips a row that is still retryable (payload present, within the window) — never hides a live retry", async () => {
    const recent = new Date(nowMs - 60 * 60_000).toISOString(); // 1h ago, well inside the window
    const { sb, updates } = fakeUnretryableSb([
      unRow({ id: "u3", provider_request: { channel: "email", email: { to: "m@example.com" } }, provider_started_at: recent }),
    ]);
    const s = await escalateUnretryableComms(sb, NOW);
    expect(s).toEqual({ stranded: 0 });
    expect(sendOpsAlert).not.toHaveBeenCalled();
    expect(resolveOperationalIssue).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("does NOT clear the signal when the human could not be notified", async () => {
    sendOpsAlert.mockResolvedValue(false);
    const { sb, updates } = fakeUnretryableSb([unRow()]);
    const s = await escalateUnretryableComms(sb, NOW);
    expect(s).toEqual({ stranded: 0 });
    expect(resolveOperationalIssue).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("caps silently WITHOUT an alert when the issue is already resolved (no spurious noise)", async () => {
    const { sb, updates } = fakeUnretryableSb([unRow()], { openIssue: false });
    const s = await escalateUnretryableComms(sb, NOW);
    expect(s).toEqual({ stranded: 0 });
    expect(sendOpsAlert).not.toHaveBeenCalled();
    expect(resolveOperationalIssue).not.toHaveBeenCalled();
    expect(updates).toEqual([{ attempt_count: COMMS_RETRY_MAX_ATTEMPTS }]); // still capped
  });

  it("names the RIGHT console per channel — Webex for SMS, not Resend (a duplicate-send trap)", async () => {
    const stale = new Date(nowMs - (COMMS_RECLAIM_WINDOW_HOURS + 1) * 60 * 60_000).toISOString();
    const { sb } = fakeUnretryableSb([
      unRow({ id: "sms1", channel: "sms", provider_request: { channel: "sms", sms: { to: "+44", body: "x" } }, provider_started_at: stale }),
    ]);
    await escalateUnretryableComms(sb, NOW);
    const lines = (sendOpsAlert.mock.calls[0][1] as string[]).join(" ");
    expect(lines).toContain("Webex");
    expect(lines).not.toContain("Resend");
  });

  it("does not claim 'may have been delivered' for a hard reject (known-undelivered)", async () => {
    const { sb } = fakeUnretryableSb([unRow({ id: "hr1", provider_outcome_unknown: false })]);
    await escalateUnretryableComms(sb, NOW);
    expect(sendOpsAlert.mock.calls[0][0]).toBe("Customer message failed to send — resend by hand");
    const lines = (sendOpsAlert.mock.calls[0][1] as string[]).join(" ");
    expect(lines).toContain("was NOT delivered");
    expect(lines).not.toMatch(/may already have been delivered/i);
  });
});
