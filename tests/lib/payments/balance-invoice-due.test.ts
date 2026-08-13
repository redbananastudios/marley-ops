import { describe, expect, it } from "vitest";
import {
  balanceInvoiceDue,
  withinT7Window,
  type BalanceInvoiceLead,
  type BalanceInvoiceQuote,
} from "@/lib/payments/balance-invoice-due";

const TODAY = "2026-08-13";
const T7 = "2026-08-20";

const quote = (over: Partial<BalanceInvoiceQuote> = {}): BalanceInvoiceQuote => ({
  status: "accepted",
  moving_date: "2026-08-18",
  zoho_balance_invoice_id: null,
  booking_cancelled_at: null,
  source: "marley_ops",
  standard_comms_at: null,
  ...over,
});
const lead = (over: Partial<BalanceInvoiceLead> = {}): BalanceInvoiceLead => ({
  status: "confirmed",
  balance_paid_at: null,
  date_confirmed_at: "2026-08-01T10:00:00Z",
  ...over,
});

describe("withinT7Window", () => {
  it("includes today and T+7, excludes outside and null", () => {
    expect(withinT7Window(TODAY, TODAY, T7)).toBe(true);
    expect(withinT7Window(T7, TODAY, T7)).toBe(true);
    expect(withinT7Window("2026-08-21", TODAY, T7)).toBe(false);
    expect(withinT7Window("2026-08-12", TODAY, T7)).toBe(false); // past move — post-move alarm's job
    expect(withinT7Window(null, TODAY, T7)).toBe(false);
  });
});

describe("balanceInvoiceDue", () => {
  it("raises for a confirmed, unsettled, in-window booking", () => {
    expect(balanceInvoiceDue(quote(), lead(), TODAY, T7)).toBe(true);
  });

  it("skips a legacy iMVE booking until standard comms is switched on", () => {
    expect(balanceInvoiceDue(quote({ source: "imve" }), lead(), TODAY, T7)).toBe(false);
    expect(
      balanceInvoiceDue(quote({ source: "imve", standard_comms_at: "2026-08-14T09:00:00Z" }), lead(), TODAY, T7),
    ).toBe(true);
  });

  it("skips when an invoice already exists — including a mid-raise 'pending' claim", () => {
    expect(balanceInvoiceDue(quote({ zoho_balance_invoice_id: "8290000123" }), lead(), TODAY, T7)).toBe(false);
    expect(balanceInvoiceDue(quote({ zoho_balance_invoice_id: "pending" }), lead(), TODAY, T7)).toBe(false);
  });

  it("skips cancelled bookings, settled leads, and non-confirmed leads", () => {
    expect(balanceInvoiceDue(quote({ booking_cancelled_at: "2026-08-10T10:00:00Z" }), lead(), TODAY, T7)).toBe(false);
    expect(balanceInvoiceDue(quote(), lead({ balance_paid_at: "2026-08-01T10:00:00Z" }), TODAY, T7)).toBe(false);
    expect(balanceInvoiceDue(quote(), lead({ status: "declined" }), TODAY, T7)).toBe(false);
    expect(balanceInvoiceDue(quote(), undefined, TODAY, T7)).toBe(false);
  });

  it("skips when the move date was never confirmed (office Mark-won leaves the stamp null)", () => {
    // Marks Davis MMR019: status='confirmed' via the office button, but the
    // customer never agreed 25 Aug — an invoice naming that date must wait.
    expect(balanceInvoiceDue(quote(), lead({ date_confirmed_at: null }), TODAY, T7)).toBe(false);
  });

  it("skips non-accepted quotes and out-of-window moves", () => {
    expect(balanceInvoiceDue(quote({ status: "sent" }), lead(), TODAY, T7)).toBe(false);
    expect(balanceInvoiceDue(quote({ moving_date: "2026-09-01" }), lead(), TODAY, T7)).toBe(false);
  });
});
