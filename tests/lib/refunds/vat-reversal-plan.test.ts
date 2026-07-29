import { describe, expect, it } from "vitest";
import { planRailVatReversals } from "@/lib/refunds/vat-reversal-plan";

describe("planRailVatReversals", () => {
  const base = {
    rail: "bank_transfer",
    rowId: "row1",
    quoteDepositInvoiceId: "inv-deposit",
    quoteDepositInvoiceNumber: "INV-1",
  };

  it("single-payment rail collapses to ONE step against the quote deposit invoice (unchanged behaviour)", () => {
    const steps = planRailVatReversals({
      ...base,
      fullAmountPence: 10000,
      payments: [{ zohoInvoiceId: "inv-deposit", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 }],
    });
    expect(steps).toEqual([
      { invoiceId: "inv-deposit", invoiceNumber: "INV-1", amountPence: 10000, idemKey: "row1-bank_transfer" },
    ]);
  });

  it("a rail with only one DUE payment (others zero) also collapses to the single call", () => {
    const steps = planRailVatReversals({
      ...base,
      fullAmountPence: 10000,
      payments: [
        { zohoInvoiceId: "inv-deposit", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        { zohoInvoiceId: "inv-commit", at: "2026-06-02T10:00:00Z", refundDuePence: 0 },
      ],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].idemKey).toBe("row1-bank_transfer");
    expect(steps[0].amountPence).toBe(10000);
  });

  it("multi-payment rail reverses EACH payment against its OWN invoice with a per-payment idemKey", () => {
    const steps = planRailVatReversals({
      ...base,
      fullAmountPence: 30000,
      payments: [
        { zohoInvoiceId: "inv-deposit", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        { zohoInvoiceId: "inv-commit", at: "2026-06-10T10:00:00Z", refundDuePence: 20000 },
      ],
    });
    expect(steps).toEqual([
      { invoiceId: "inv-deposit", invoiceNumber: null, amountPence: 10000, idemKey: "row1-bank_transfer-2026-06-01T10:00:00Z" },
      { invoiceId: "inv-commit", invoiceNumber: null, amountPence: 20000, idemKey: "row1-bank_transfer-2026-06-10T10:00:00Z" },
    ]);
    // The split sums to the full amount — no money is lost or double-reversed.
    expect(steps.reduce((s, x) => s + x.amountPence, 0)).toBe(30000);
  });

  it("a multi-payment payment with an unknown invoice yields a null invoice (→ safe manual fallback), never the wrong one", () => {
    const steps = planRailVatReversals({
      ...base,
      fullAmountPence: 30000,
      payments: [
        { zohoInvoiceId: null, at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        { zohoInvoiceId: "inv-commit", at: "2026-06-10T10:00:00Z", refundDuePence: 20000 },
      ],
    });
    expect(steps[0].invoiceId).toBeNull();
    expect(steps[1].invoiceId).toBe("inv-commit");
  });
});
