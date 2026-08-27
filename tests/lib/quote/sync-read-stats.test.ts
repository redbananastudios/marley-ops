import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `syncZohoPayments` polls the ledger for payments recorded outside the app. Its
 * three catches are deliberately non-fatal — a transient outage genuinely is
 * caught by the next pass, and throwing would abandon the rest of the sweep.
 *
 * But they used to be SILENT, and that made a total provider outage
 * indistinguishable from a day nobody paid: the cron returned
 * `{checked: 25, settled: 0}` either way, `runCron` saw no throw, and it then
 * RESOLVED the job's operational issue — clearing the only surface that would
 * have shown the problem.
 *
 * These tests pin the counting, not the swallowing. The swallow is correct; the
 * silence was not.
 */

const { getInvoiceStatus } = vi.hoisted(() => ({ getInvoiceStatus: vi.fn() }));

vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  getInvoiceStatus,
}));

import { syncZohoPayments, type LedgerReadStats } from "@/lib/quote/accept-flow";

/* Structural stand-ins for the two real parameter types. `Sb` is not exported
   and `AcceptQuoteRow` has ~40 fields none of these branches read, so widen
   through the function's own signature rather than reaching for `any`. */
type SbArg = Parameters<typeof syncZohoPayments>[0];
type QuoteArg = Parameters<typeof syncZohoPayments>[1];
const asSb = (v: unknown) => v as SbArg;
const asQuote = (v: unknown) => v as QuoteArg;

/** Minimal `leads` read for the balance branch: an unpaid lead. */
const sb = asSb({
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: { balance_paid_at: null }, error: null }),
      }),
    }),
  }),
});

/** A quote with all three invoice slots open — the maximum-read case. */
const quote = asQuote({
  id: "q1",
  lead_id: "l1",
  zoho_deposit_invoice_id: "111111",
  zoho_commitment_invoice_id: "222222",
  zoho_balance_invoice_id: "333333",
  deposit_paid_at: null,
  commitment_paid_at: null,
});

const stats = (): LedgerReadStats => ({ attempted: 0, failed: 0 });

beforeEach(() => vi.clearAllMocks());

describe("counting reads that could not be completed", () => {
  it("counts every failed read and still returns the quote rather than throwing", async () => {
    getInvoiceStatus.mockRejectedValue(new Error("ledger unreachable"));
    const s = stats();
    await expect(syncZohoPayments(sb, quote, s)).resolves.toBe(quote);
    expect(s).toEqual({ attempted: 3, failed: 3 });
  });

  /**
   * The distinction the whole fix exists for: three successful reads that found
   * nothing, versus three reads that never happened. Both settle nothing.
   */
  it("counts attempts without failures when the ledger answers 'not paid'", async () => {
    getInvoiceStatus.mockResolvedValue({
      invoiceId: "i",
      invoiceNumber: "INV-1",
      invoiceUrl: null,
      status: "sent",
      total: 100,
      balance: 100,
    });
    const s = stats();
    await syncZohoPayments(sb, quote, s);
    expect(s).toEqual({ attempted: 3, failed: 0 });
  });

  it("counts a partial outage as partial, not as total blindness", async () => {
    getInvoiceStatus
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue({
        invoiceId: "i",
        invoiceNumber: "INV-1",
        invoiceUrl: null,
        status: "sent",
        total: 100,
        balance: 100,
      });
    const s = stats();
    await syncZohoPayments(sb, quote, s);
    expect(s).toEqual({ attempted: 3, failed: 1 });
  });

  it("attempts nothing for a quote with no open invoice slots", async () => {
    const s = stats();
    await syncZohoPayments(sb, asQuote({ id: "q2", lead_id: null, zoho_deposit_invoice_id: null }), s);
    expect(s).toEqual({ attempted: 0, failed: 0 });
    expect(getInvoiceStatus).not.toHaveBeenCalled();
  });

  /**
   * A slot still holding the 'pending' creation claim is not a readable invoice.
   * Counting it as an attempted read would make an ordinary in-flight create
   * look like an outage.
   */
  it("does not read a slot still holding the pending creation claim", async () => {
    const s = stats();
    await syncZohoPayments(
      sb,
      asQuote({
        id: "q3",
        lead_id: null,
        zoho_deposit_invoice_id: "pending",
        zoho_commitment_invoice_id: "pending",
        deposit_paid_at: null,
        commitment_paid_at: null,
      }),
      s,
    );
    expect(s).toEqual({ attempted: 0, failed: 0 });
    expect(getInvoiceStatus).not.toHaveBeenCalled();
  });

  /**
   * The /q page omits the collector — that read self-heals on the next page load
   * and has a human looking at the result. It must not become a required arg.
   */
  it("works without a collector, so the customer page is unaffected", async () => {
    getInvoiceStatus.mockRejectedValue(new Error("ledger unreachable"));
    await expect(syncZohoPayments(sb, quote)).resolves.toBe(quote);
  });
});
