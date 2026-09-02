import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The watchdog's books probe must certify the SAME system the raises use.
 *
 * Before this fix it called `checkZohoAccess()` unconditionally: with
 * `LEDGER_PROVIDER=xero` the probe greened off a healthy Zoho while Xero was
 * locked out (the probe certified the wrong system), and — worse — the green
 * Zoho probe then AUTO-RESOLVED the shared lock-out issue that a failed Xero
 * invoice raise had just opened. The monitor erased the very alarm it existed
 * to corroborate. Same class as the 2026-08-27 `GET /organizations` miss: a
 * probe must exercise the scope of the thing it certifies.
 *
 * These tests pin: probe routing by configured provider, resolve scoping to
 * the probed provider only, and byte-identical zoho behaviour.
 */

const seam = vi.hoisted(() => ({
  checkLedgerAccess: vi.fn(),
}));
const zoho = vi.hoisted(() => ({
  checkZohoAccess: vi.fn(),
}));
const access = vi.hoisted(() => ({
  // Old names kept in the factory so the test file loads against any tree
  // shape; the assertions are what enforce the new behaviour.
  reportZohoAccessDenied: vi.fn(async () => {}),
  resolveZohoAccessDenied: vi.fn(async () => {}),
  reportLedgerAccessDenied: vi.fn<
    (sb: unknown, input: { provider: string; message: string; while: string }) => Promise<void>
  >(async () => {}),
  resolveLedgerAccessDenied: vi.fn<(sb: unknown, provider: string) => Promise<void>>(
    async () => {},
  ),
  reportLedgerRateLimited: vi.fn<
    (sb: unknown, input: { provider: string; message: string; while: string }) => Promise<void>
  >(async () => {}),
  resolveLedgerRateLimited: vi.fn<(sb: unknown, provider: string) => Promise<void>>(async () => {}),
  ledgerAccessIssueKey: (p: string) => `${p}:access-denied`,
  ledgerRateLimitIssueKey: (p: string) => `${p}:rate-limited`,
  ZOHO_ACCESS_ISSUE_KEY: "zoho:access-denied",
}));
const issues = vi.hoisted(() => ({
  reportOperationalIssue: vi.fn(async () => {}),
  resolveOperationalIssue: vi.fn(async () => {}),
  checkpointOperationalIssues: vi.fn(async () => 0),
  deliverDailyOperationalIssueDigest: vi.fn(async () => "none" as const),
}));
const comms = vi.hoisted(() => ({
  sendSms: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  ...seam,
}));
vi.mock("@/lib/zoho", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/zoho")>()),
  ...zoho,
}));
vi.mock("@/lib/ops/zoho-access", () => access);
vi.mock("@/lib/ops/issues", () => issues);
vi.mock("@/lib/comms/send", () => comms);

import { runHealthWatchdog } from "@/lib/watchdog";

/**
 * A supabase stand-in whose every chain is fresh and empty: each registered
 * cron ran a minute ago, the bank feed saw money a minute ago, no operational
 * issues are open, nothing was SMS'd recently. The only alertable thing in the
 * world is whatever the mocked books probe says — which is the point.
 */
function fakeSb() {
  const fresh = new Date(Date.now() - 60_000).toISOString();
  const chain = (table: string) => {
    const rows: Record<string, unknown[]> = {
      cron_runs: [],
      operational_issues: [],
    };
    const single: Record<string, unknown> = {
      cron_runs: { finished_at: fresh },
      bank_transactions: { created_at: fresh },
    };
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "limit", "is", "update"]) {
      self[m] = () => self;
    }
    self.maybeSingle = async () => ({ data: single[table] ?? null, error: null });
    self.then = (resolve: (v: unknown) => void) => resolve({ data: rows[table] ?? [], error: null });
    return self;
  };
  return {
    from: (table: string) => chain(table),
    rpc: async () => ({ data: null, error: null }),
  } as never;
}

const originalProvider = process.env.LEDGER_PROVIDER;
const originalSms = process.env.OPS_ALERT_SMS;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPS_ALERT_SMS;
});
afterEach(() => {
  if (originalProvider === undefined) delete process.env.LEDGER_PROVIDER;
  else process.env.LEDGER_PROVIDER = originalProvider;
  if (originalSms === undefined) delete process.env.OPS_ALERT_SMS;
  else process.env.OPS_ALERT_SMS = originalSms;
});

describe("runHealthWatchdog — books probe goes through the ledger seam", () => {
  it("provider=xero probes XERO, and never calls the Zoho probe at all", async () => {
    process.env.LEDGER_PROVIDER = "xero";
    seam.checkLedgerAccess.mockResolvedValue({ ok: true });
    zoho.checkZohoAccess.mockResolvedValue({ ok: true });

    await runHealthWatchdog(fakeSb());

    expect(seam.checkLedgerAccess).toHaveBeenCalledWith("xero");
    expect(zoho.checkZohoAccess).not.toHaveBeenCalled();
  });

  it("provider=zoho probes through the seam too — the watchdog holds no direct provider client", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    seam.checkLedgerAccess.mockResolvedValue({ ok: true });
    zoho.checkZohoAccess.mockResolvedValue({ ok: true });

    await runHealthWatchdog(fakeSb());

    expect(seam.checkLedgerAccess).toHaveBeenCalledWith("zoho");
    expect(zoho.checkZohoAccess).not.toHaveBeenCalled();
  });

  it("a xero lock-out raises a xero-keyed alert naming the Xero remedy", async () => {
    process.env.LEDGER_PROVIDER = "xero";
    seam.checkLedgerAccess.mockResolvedValue({
      ok: false,
      accessDenied: true,
      message: "Xero token request failed: invalid_grant",
    });

    const summary = await runHealthWatchdog(fakeSb());

    const alert = summary.alerts.find((a) => a.key === "xero-access");
    expect(alert).toBeDefined();
    expect(alert!.message).toMatch(/xero/i);
    expect(alert!.message).not.toMatch(/zoho/i);
  });

  it("provider=zoho lock-out behaviour is byte-identical to today", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    seam.checkLedgerAccess.mockResolvedValue({
      ok: false,
      accessDenied: true,
      message: "You do not have access as your account is disabled.",
    });

    const summary = await runHealthWatchdog(fakeSb());

    expect(summary.alerts).toEqual([
      {
        key: "zoho-access",
        message:
          "Zoho is refusing the ops integration — no invoices are being raised. Re-enable the ops user in Zoho",
      },
    ]);
  });
});

describe("runHealthWatchdog — auto-resolve is scoped to the probed provider", () => {
  it("a green probe resolves the probed provider's issue, and no other", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    seam.checkLedgerAccess.mockResolvedValue({ ok: true });

    await runHealthWatchdog(fakeSb());

    expect(access.resolveLedgerAccessDenied).toHaveBeenCalledTimes(1);
    expect(access.resolveLedgerAccessDenied.mock.calls[0][1]).toBe("zoho");
  });

  it("with provider=xero locked out, a healthy Zoho clears NOTHING — the alarm must survive its own monitor", async () => {
    process.env.LEDGER_PROVIDER = "xero";
    // Zoho itself is perfectly healthy — exactly the state that used to erase
    // the Xero alarm.
    zoho.checkZohoAccess.mockResolvedValue({ ok: true });
    seam.checkLedgerAccess.mockResolvedValue({
      ok: false,
      accessDenied: true,
      message: "Xero token request failed: invalid_grant",
    });

    await runHealthWatchdog(fakeSb());

    expect(access.resolveLedgerAccessDenied).not.toHaveBeenCalled();
    expect(access.resolveZohoAccessDenied).not.toHaveBeenCalled();
  });

  it("a transient failure resolves nothing either — only a GREEN probe may clear", async () => {
    process.env.LEDGER_PROVIDER = "xero";
    seam.checkLedgerAccess.mockResolvedValue({
      ok: false,
      accessDenied: false,
      message: "Xero organisation read failed (HTTP 503)",
    });

    const summary = await runHealthWatchdog(fakeSb());

    expect(access.resolveLedgerAccessDenied).not.toHaveBeenCalled();
    expect(summary.alerts).toEqual([]); // transient: clears itself next pass
  });
});

/**
 * The gap this closes: under a spent quota the probe answers
 * `{ok: false, accessDenied: false}`, which every rule in this file reads as a
 * transient blip. So the 15-minute watchdog said NOTHING for a whole day of
 * failed invoicing — an absence of findings that proved only that nothing could
 * classify what it saw.
 */
describe("runHealthWatchdog — a spent quota is reported, not read as a blip", () => {
  it("alerts under the quota's own key rather than falling through as transient", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    seam.checkLedgerAccess.mockResolvedValue({
      ok: false,
      accessDenied: false,
      rateLimited: true,
      message: "The API call for this organisation has exceeded the maximum call rate limit of 1,000",
    });

    const summary = await runHealthWatchdog(fakeSb());

    const alert = summary.alerts.find((a) => a.key === "zoho-rate-limit");
    expect(alert).toBeDefined();
    expect(summary.alerts.find((a) => a.key === "zoho-access")).toBeUndefined();
  });

  it("resolves nothing while the quota is spent — neither alarm has gone green", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    seam.checkLedgerAccess.mockResolvedValue({
      ok: false,
      accessDenied: false,
      rateLimited: true,
      message: "rate limit",
    });

    await runHealthWatchdog(fakeSb());

    expect(access.resolveLedgerAccessDenied).not.toHaveBeenCalled();
    expect(access.resolveLedgerRateLimited).not.toHaveBeenCalled();
  });

  /**
   * The reset is the only thing that clears this, and the probe is the only
   * thing that sees it: no invoice raise is guaranteed to run afterwards, so
   * without this the issue would sit open on the ops board forever.
   */
  it("a green probe clears the quota alarm as well as the lock-out one", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    seam.checkLedgerAccess.mockResolvedValue({ ok: true });

    await runHealthWatchdog(fakeSb());

    expect(access.resolveLedgerRateLimited).toHaveBeenCalledTimes(1);
    expect(access.resolveLedgerRateLimited.mock.calls[0][1]).toBe("zoho");
  });
});

describe("runHealthWatchdog — a broken ledger config is an alarm, not a crash", () => {
  it("garbled LEDGER_PROVIDER alerts instead of killing the watchdog with its subject", async () => {
    process.env.LEDGER_PROVIDER = "xerro";

    const summary = await runHealthWatchdog(fakeSb());

    const alert = summary.alerts.find((a) => a.key === "ledger-config");
    expect(alert).toBeDefined();
    expect(access.resolveLedgerAccessDenied).not.toHaveBeenCalled();
  });
});
