import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The payment watcher polls invoices by their PER-DOCUMENT provider stamp
 * (design §8), so after a cutover a single sweep can read Zoho-minted and
 * Xero-minted invoices in one pass. When a read is refused permanently, the
 * lock-out alert must therefore name the provider whose read failed — not
 * whichever provider the env happens to be configured for. Attributing a Xero
 * lock-out to Zoho would page a human into the wrong system AND open an issue
 * under a key that a later healthy-Zoho pass would clear.
 */

const { getInvoiceStatus } = vi.hoisted(() => ({ getInvoiceStatus: vi.fn() }));
const access = vi.hoisted(() => ({
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
}));

vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  getInvoiceStatus,
}));

vi.mock("@/lib/ops/zoho-access", () => access);

import { syncZohoPayments } from "@/lib/quote/accept-flow";
import { LedgerError } from "@/lib/ledger/types";

type SbArg = Parameters<typeof syncZohoPayments>[0];
type QuoteArg = Parameters<typeof syncZohoPayments>[1];
const asSb = (v: unknown) => v as SbArg;
const asQuote = (v: unknown) => v as QuoteArg;

const sb = asSb({
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { balance_paid_at: null }, error: null }),
      }),
    }),
  }),
});

const lockedOut = () =>
  new LedgerError("Xero token request failed: invalid_grant", undefined, 400);

/** The shape the staging org actually returned once its daily allowance went. */
const quotaSpent = () =>
  new LedgerError(
    "The API call for this organisation has exceeded the maximum call rate limit of 1,000",
    45,
    429,
  );

const originalProvider = process.env.LEDGER_PROVIDER;
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LEDGER_PROVIDER;
});
afterEach(() => {
  if (originalProvider === undefined) delete process.env.LEDGER_PROVIDER;
  else process.env.LEDGER_PROVIDER = originalProvider;
});

describe("syncZohoPayments — lock-out attribution follows the document's provider", () => {
  it("a xero-stamped invoice that is refused reports a XERO lock-out, even while the env is zoho", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    getInvoiceStatus.mockRejectedValue(lockedOut());

    const r = await syncZohoPayments(
      sb,
      asQuote({
        id: "q1",
        lead_id: null,
        zoho_deposit_invoice_id: "0af52c46-9397-4f24-b91b-ec9e3f5a05e9",
        deposit_invoice_provider: "xero",
        deposit_paid_at: null,
      }),
    );

    expect(r.accessDenied).toBe(true);
    expect(access.reportLedgerAccessDenied).toHaveBeenCalledTimes(1);
    expect(access.reportLedgerAccessDenied.mock.calls[0][1]).toEqual({
      provider: "xero",
      message: "invoice status unreadable",
      while: "payment watch",
    });
  });

  it("an unstamped invoice falls back to the configured provider (zoho by default)", async () => {
    getInvoiceStatus.mockRejectedValue(
      new LedgerError("You do not have access as your account is disabled.", 6018, 200),
    );

    await syncZohoPayments(
      sb,
      asQuote({
        id: "q2",
        lead_id: null,
        zoho_deposit_invoice_id: "111111",
        deposit_invoice_provider: null,
        deposit_paid_at: null,
      }),
    );

    expect(access.reportLedgerAccessDenied).toHaveBeenCalledTimes(1);
    expect(access.reportLedgerAccessDenied.mock.calls[0][1]).toMatchObject({ provider: "zoho" });
  });

  it("a mixed sweep with both providers refused raises BOTH alarms — one per broken integration", async () => {
    process.env.LEDGER_PROVIDER = "xero";
    getInvoiceStatus.mockRejectedValue(lockedOut());

    await syncZohoPayments(
      sb,
      asQuote({
        id: "q3",
        lead_id: null,
        zoho_deposit_invoice_id: "111111",
        deposit_invoice_provider: "zoho",
        zoho_commitment_invoice_id: "0af52c46-9397-4f24-b91b-ec9e3f5a05e9",
        commitment_invoice_provider: "xero",
        deposit_paid_at: null,
        commitment_paid_at: null,
      }),
    );

    const reported = access.reportLedgerAccessDenied.mock.calls.map((c) => c[1].provider).sort();
    expect(reported).toEqual(["xero", "zoho"]);
  });

  it("one refused provider does not smear onto the other's clean reads", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    // The zoho-stamped read answers; the xero-stamped one is locked out.
    getInvoiceStatus.mockImplementation(async (_id: string, provider?: string | null) => {
      if (provider === "xero") throw lockedOut();
      return { invoiceId: "i", invoiceNumber: "INV-1", invoiceUrl: null, status: "sent", total: 100, balance: 100 };
    });

    await syncZohoPayments(
      sb,
      asQuote({
        id: "q4",
        lead_id: null,
        zoho_deposit_invoice_id: "111111",
        deposit_invoice_provider: "zoho",
        zoho_commitment_invoice_id: "0af52c46-9397-4f24-b91b-ec9e3f5a05e9",
        commitment_invoice_provider: "xero",
        deposit_paid_at: null,
        commitment_paid_at: null,
      }),
    );

    expect(access.reportLedgerAccessDenied).toHaveBeenCalledTimes(1);
    expect(access.reportLedgerAccessDenied.mock.calls[0][1]).toMatchObject({ provider: "xero" });
  });
});

/**
 * A spent quota refuses every read exactly like a lock-out does, so the watcher
 * has to escalate it — but to the alarm whose remedy is true. Left
 * unclassified it produced the 2026-08-27 shape all over again: a quiet
 * `unreadable` count and per-quote noise for one integration-wide cause.
 */
describe("syncZohoPayments — a spent quota is escalated as a quota, not as a lock-out", () => {
  it("reports the rate limit and does NOT report a lock-out", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    getInvoiceStatus.mockRejectedValue(quotaSpent());

    const r = await syncZohoPayments(
      sb,
      asQuote({
        id: "q5",
        lead_id: null,
        zoho_deposit_invoice_id: "111111",
        deposit_invoice_provider: "zoho",
        deposit_paid_at: null,
      }),
    );

    expect(access.reportLedgerRateLimited).toHaveBeenCalledTimes(1);
    expect(access.reportLedgerRateLimited.mock.calls[0][1]).toEqual({
      provider: "zoho",
      message: "invoice status unreadable",
      while: "payment watch",
    });
    // The user was never disabled and the grant was never revoked.
    expect(access.reportLedgerAccessDenied).not.toHaveBeenCalled();
    expect(r.accessDenied).toBe(false);
    // …but the read still failed, so the sweep must not read as a quiet pass.
    expect(r.unreadable).toBe(1);
  });

  it("attributes the quota to the provider whose read was refused, like the lock-out does", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    getInvoiceStatus.mockRejectedValue(quotaSpent());

    await syncZohoPayments(
      sb,
      asQuote({
        id: "q6",
        lead_id: null,
        zoho_deposit_invoice_id: "0af52c46-9397-4f24-b91b-ec9e3f5a05e9",
        deposit_invoice_provider: "xero",
        deposit_paid_at: null,
      }),
    );

    expect(access.reportLedgerRateLimited.mock.calls[0][1]).toMatchObject({ provider: "xero" });
  });

  it("raises ONE alarm per provider however many invoices the sweep could not read", async () => {
    process.env.LEDGER_PROVIDER = "zoho";
    getInvoiceStatus.mockRejectedValue(quotaSpent());

    await syncZohoPayments(
      sb,
      asQuote({
        id: "q7",
        lead_id: null,
        zoho_deposit_invoice_id: "111111",
        deposit_invoice_provider: "zoho",
        zoho_commitment_invoice_id: "222222",
        commitment_invoice_provider: "zoho",
        deposit_paid_at: null,
        commitment_paid_at: null,
      }),
    );

    expect(access.reportLedgerRateLimited).toHaveBeenCalledTimes(1);
  });
});
