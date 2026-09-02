import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Companion to `zoho-payment-sync-blindness.test.ts`, which pins the PERMANENT
 * lock-out class. This file pins the counting the other escalation needs.
 *
 * The two exist because `staging` and `master` fixed the same silent-poller bug
 * independently and caught different failures, and the merge keeps both:
 *
 *  - `accessDenied` — one permanent failure is enough. It will not clear.
 *  - `attempted` / `unreadable` — feeds `blindSweepFailure`, which fails a run
 *    where EVERY read failed even when no single error was classifiable. A
 *    total outage returning nothing recognisable escalates through this path
 *    and through no other.
 *
 * The counts are also what keep a PARTIAL failure a green run with a visible
 * number rather than an alarm: one timeout in twenty-five genuinely does clear
 * next pass, and crying wolf on it is how the alert gets ignored.
 */

const { getInvoiceStatus } = vi.hoisted(() => ({ getInvoiceStatus: vi.fn() }));

vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  getInvoiceStatus,
}));

vi.mock("@/lib/ops/zoho-access", () => ({
  ledgerAccessIssueKey: (p: string) => `${p}:access-denied`,
  ledgerRateLimitIssueKey: (p: string) => `${p}:rate-limited`,
  reportLedgerAccessDenied: async () => {},
  resolveLedgerAccessDenied: async () => {},
  reportLedgerRateLimited: async () => {},
  resolveLedgerRateLimited: async () => {},
}));

import { syncZohoPayments } from "@/lib/quote/accept-flow";

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
  deposit_invoice_provider: "zoho",
  commitment_invoice_provider: "zoho",
  balance_invoice_provider: "zoho",
  deposit_paid_at: null,
  commitment_paid_at: null,
});

const unpaid = {
  invoiceId: "i",
  invoiceNumber: "INV-1",
  invoiceUrl: null,
  status: "sent",
  total: 100,
  balance: 100,
};

beforeEach(() => vi.clearAllMocks());

describe("counting reads that could not be completed", () => {
  it("counts every failed read and still returns the quote rather than throwing", async () => {
    getInvoiceStatus.mockRejectedValue(new Error("ledger unreachable"));
    const r = await syncZohoPayments(sb, quote);
    expect(r.quote).toBe(quote);
    expect(r.attempted).toBe(3);
    expect(r.unreadable).toBe(3);
  });

  /**
   * The distinction the whole fix exists for: three successful reads that found
   * nothing, versus three reads that never happened. Both settle nothing.
   */
  it("counts attempts without failures when the ledger answers 'not paid'", async () => {
    getInvoiceStatus.mockResolvedValue(unpaid);
    const r = await syncZohoPayments(sb, quote);
    expect(r.attempted).toBe(3);
    expect(r.unreadable).toBe(0);
  });

  it("counts a partial outage as partial, not as total blindness", async () => {
    getInvoiceStatus.mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(unpaid);
    const r = await syncZohoPayments(sb, quote);
    expect(r.attempted).toBe(3);
    expect(r.unreadable).toBe(1);
  });

  /**
   * An ordinary network error is NOT a lock-out. Escalating it would put a
   * permanent-looking ops alert on a blip that clears itself.
   */
  it("does not mistake a transient failure for a lock-out", async () => {
    getInvoiceStatus.mockRejectedValue(new Error("socket hang up"));
    expect((await syncZohoPayments(sb, quote)).accessDenied).toBe(false);
  });

  it("attempts nothing for a quote with no open invoice slots", async () => {
    const r = await syncZohoPayments(sb, asQuote({ id: "q2", lead_id: null, zoho_deposit_invoice_id: null }));
    expect(r.attempted).toBe(0);
    expect(r.unreadable).toBe(0);
    expect(getInvoiceStatus).not.toHaveBeenCalled();
  });

  /**
   * A slot still holding the 'pending' creation claim is not a readable invoice.
   * Counting it as an attempted read would make an ordinary in-flight create
   * look like an outage.
   */
  it("does not read a slot still holding the pending creation claim", async () => {
    const r = await syncZohoPayments(
      sb,
      asQuote({
        id: "q3",
        lead_id: null,
        zoho_deposit_invoice_id: "pending",
        zoho_commitment_invoice_id: "pending",
        deposit_paid_at: null,
        commitment_paid_at: null,
      }),
    );
    expect(r.attempted).toBe(0);
    expect(getInvoiceStatus).not.toHaveBeenCalled();
  });
});
