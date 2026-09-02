import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-08-27, live: Zoho deactivated the org user behind the ops refresh token.
 * Every `getInvoiceStatus` call returned code 6018 — and syncZohoPayments
 * caught them into empty blocks, so the payment watcher reported
 * `{checked: 9, settled: 0}` every 15 minutes for hours. That summary reads as
 * "nine invoices checked, none of them paid". Nine invoices had not been read
 * at all, and a deposit settled in Zoho in that window would have gone
 * unnoticed with every dashboard green.
 *
 * These tests pin the distinction the empty catches destroyed: an unreadable
 * invoice is NOT an unpaid invoice.
 */

const statusMock = vi.fn();
const reportAccessDenied = vi.fn<(sb: unknown, input: unknown) => Promise<void>>();

vi.mock("@/lib/zoho", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/zoho")>()),
  getInvoiceStatus: (invoiceId: string) => statusMock(invoiceId),
}));

vi.mock("@/lib/ops/zoho-access", () => ({
  ledgerAccessIssueKey: (p: string) => `${p}:access-denied`,
  ledgerRateLimitIssueKey: (p: string) => `${p}:rate-limited`,
  reportLedgerAccessDenied: (sb: unknown, input: unknown) => reportAccessDenied(sb, input),
  resolveLedgerAccessDenied: async () => {},
  reportLedgerRateLimited: async () => {},
  resolveLedgerRateLimited: async () => {},
}));

const { syncZohoPayments } = await import("@/lib/quote/accept-flow");
const { ZohoError } = await import("@/lib/zoho");

/** Only the columns syncZohoPayments actually reads. */
const quote = () =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    quote_ref: "MMR112",
    lead_id: null,
    zoho_deposit_invoice_id: "3210000000000099",
    zoho_commitment_invoice_id: null,
    zoho_balance_invoice_id: null,
    deposit_paid_at: null,
    commitment_paid_at: null,
    balance_invoice_amount: null,
  }) as never;

const sb = {} as never;

beforeEach(() => {
  statusMock.mockReset();
  reportAccessDenied.mockReset();
});

describe("syncZohoPayments — could-not-check vs nothing-to-report", () => {
  it("a genuinely unpaid invoice reads clean: nothing unreadable", async () => {
    statusMock.mockResolvedValue({ status: "sent", balance: 100 });
    const res = await syncZohoPayments(sb, quote());
    expect(res.unreadable).toBe(0);
    expect(res.accessDenied).toBe(false);
    expect(reportAccessDenied).not.toHaveBeenCalled();
  });

  it("a lock-out is counted AND escalated — never reported as 'not paid'", async () => {
    statusMock.mockRejectedValue(
      new ZohoError("You do not have access as your account is disabled.", 6018, 200),
    );
    const res = await syncZohoPayments(sb, quote());
    expect(res.unreadable).toBe(1);
    expect(res.accessDenied).toBe(true);
    expect(reportAccessDenied).toHaveBeenCalledTimes(1);
  });

  it("a transient failure is counted but NOT escalated — it clears itself", async () => {
    statusMock.mockRejectedValue(new ZohoError("Zoho error 503", undefined, 503));
    const res = await syncZohoPayments(sb, quote());
    expect(res.unreadable).toBe(1);
    expect(res.accessDenied).toBe(false);
    expect(reportAccessDenied).not.toHaveBeenCalled();
  });

  it("counts every invoice it could not read, not just the first", async () => {
    const q = quote() as Record<string, unknown>;
    q.zoho_commitment_invoice_id = "3210000000000100";
    statusMock.mockRejectedValue(new ZohoError("Zoho error 503", undefined, 503));
    const res = await syncZohoPayments(sb, q as never);
    expect(res.unreadable).toBe(2);
  });
});
