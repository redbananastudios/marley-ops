import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planRailVatReversals } from "@/lib/refunds/vat-reversal-plan";

describe("planRailVatReversals", () => {
  const base = {
    rail: "bank_transfer",
    rowId: "row1",
    quoteDepositInvoiceId: "inv-deposit",
    quoteDepositInvoiceNumber: "INV-1",
    quoteDepositInvoiceProvider: "zoho" as string | null,
  };

  it("single-payment rail collapses to ONE step against the quote deposit invoice (unchanged behaviour)", () => {
    const steps = planRailVatReversals({
      ...base,
      fullAmountPence: 10000,
      payments: [{ zohoInvoiceId: "inv-deposit", ledgerProvider: "zoho", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 }],
    });
    expect(steps).toEqual([
      { invoiceId: "inv-deposit", invoiceNumber: "INV-1", invoiceProvider: "zoho", amountPence: 10000, idemKey: "row1-bank_transfer" },
    ]);
  });

  it("a rail with only one DUE payment (others zero) also collapses to the single call", () => {
    const steps = planRailVatReversals({
      ...base,
      fullAmountPence: 10000,
      payments: [
        { zohoInvoiceId: "inv-deposit", ledgerProvider: "zoho", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        { zohoInvoiceId: "inv-commit", ledgerProvider: "zoho", at: "2026-06-02T10:00:00Z", refundDuePence: 0 },
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
        { zohoInvoiceId: "inv-deposit", ledgerProvider: "zoho", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        { zohoInvoiceId: "inv-commit", ledgerProvider: "zoho", at: "2026-06-10T10:00:00Z", refundDuePence: 20000 },
      ],
    });
    expect(steps).toEqual([
      { invoiceId: "inv-deposit", invoiceNumber: null, invoiceProvider: "zoho", amountPence: 10000, idemKey: "row1-bank_transfer-2026-06-01T10:00:00Z" },
      { invoiceId: "inv-commit", invoiceNumber: null, invoiceProvider: "zoho", amountPence: 20000, idemKey: "row1-bank_transfer-2026-06-10T10:00:00Z" },
    ]);
    // The split sums to the full amount — no money is lost or double-reversed.
    expect(steps.reduce((s, x) => s + x.amountPence, 0)).toBe(30000);
  });

  it("a multi-payment payment with an unknown invoice yields a null invoice (→ safe manual fallback), never the wrong one", () => {
    const steps = planRailVatReversals({
      ...base,
      fullAmountPence: 30000,
      payments: [
        { zohoInvoiceId: null, ledgerProvider: null, at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        { zohoInvoiceId: "inv-commit", ledgerProvider: "zoho", at: "2026-06-10T10:00:00Z", refundDuePence: 20000 },
      ],
    });
    expect(steps[0].invoiceId).toBeNull();
    expect(steps[1].invoiceId).toBe("inv-commit");
  });
});

/* ---------------------------------------- per-step provider stamp (0109) */

/**
 * A stored invoice id says nothing about which system minted it (0109), and a
 * rail can aggregate payments whose invoices straddle the Zoho→Xero flip — a
 * Zoho deposit beside a Xero commitment is the NORMAL state of a live booking
 * crossing the cutover, not an edge case. Each reversal step must therefore
 * carry the provider of the invoice IT reverses; handing the deposit slot's
 * provider to every step reads the commitment's id against a system that
 * never minted it.
 */
describe("planRailVatReversals — each step resolves its OWN invoice's provider", () => {
  const stamped = {
    rail: "bank_transfer",
    rowId: "row1",
    quoteDepositInvoiceId: "inv-deposit",
    quoteDepositInvoiceNumber: "INV-1",
    quoteDepositInvoiceProvider: "zoho" as string | null,
  };

  it("straddling rungs: the deposit step is zoho, the commitment step is xero — never the deposit's stamp for both", () => {
    const steps = planRailVatReversals({
      ...stamped,
      fullAmountPence: 30000,
      payments: [
        { zohoInvoiceId: "inv-deposit", ledgerProvider: "zoho", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        { zohoInvoiceId: "xero-commit", ledgerProvider: "xero", at: "2026-09-20T10:00:00Z", refundDuePence: 20000 },
      ],
    });
    expect(steps.map((s) => [s.invoiceId, s.invoiceProvider])).toEqual([
      ["inv-deposit", "zoho"],
      ["xero-commit", "xero"],
    ]);
  });

  it("the single-payment collapse reverses the QUOTE's deposit invoice, so it carries the DEPOSIT slot's provider", () => {
    const steps = planRailVatReversals({
      ...stamped,
      quoteDepositInvoiceProvider: "xero",
      fullAmountPence: 10000,
      payments: [
        { zohoInvoiceId: "inv-deposit", ledgerProvider: "xero", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
      ],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].invoiceId).toBe("inv-deposit");
    expect(steps[0].invoiceProvider).toBe("xero");
  });

  it("a rung with no stamp yields null (→ the codebase's configured-provider convention), NEVER a sibling's stamp", () => {
    const steps = planRailVatReversals({
      ...stamped,
      fullAmountPence: 30000,
      payments: [
        { zohoInvoiceId: "inv-deposit", ledgerProvider: "zoho", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        // A pre-fix snapshot: the id froze without its stamp.
        { zohoInvoiceId: "inv-commit", ledgerProvider: null, at: "2026-06-10T10:00:00Z", refundDuePence: 20000 },
      ],
    });
    expect(steps[1].invoiceProvider).toBeNull();
  });

  it("control: amounts and idemKeys are byte-identical to the pre-stamp behaviour", () => {
    const steps = planRailVatReversals({
      ...stamped,
      fullAmountPence: 30000,
      payments: [
        { zohoInvoiceId: "inv-deposit", ledgerProvider: "zoho", at: "2026-06-01T10:00:00Z", refundDuePence: 10000 },
        { zohoInvoiceId: "inv-commit", ledgerProvider: "zoho", at: "2026-06-10T10:00:00Z", refundDuePence: 20000 },
      ],
    });
    expect(steps.map((s) => ({ invoiceId: s.invoiceId, amountPence: s.amountPence, idemKey: s.idemKey }))).toEqual([
      { invoiceId: "inv-deposit", amountPence: 10000, idemKey: "row1-bank_transfer-2026-06-01T10:00:00Z" },
      { invoiceId: "inv-commit", amountPence: 20000, idemKey: "row1-bank_transfer-2026-06-10T10:00:00Z" },
    ]);
  });
});

/**
 * Wiring, asserted at the source (the card-toggle pattern): the pure plan can
 * be perfect and the action can still hand every step the DEPOSIT slot's
 * stamp — which is exactly the defect this closes. No unit seam exists for
 * the server action, so pin the two load-bearing lines.
 */
describe("the refund action + snapshot are actually wired to the per-step stamp", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("markRailRefundedAction passes each step ITS OWN provider, not the deposit slot's", () => {
    const src = read("app/actions/refunds.ts");
    expect(src, "the reversal loop no longer resolves the step's own provider").toContain(
      "depositInvoiceProvider: step.invoiceProvider",
    );
  });

  it("buildHeldSnapshot freezes the three slot stamps beside the ids they describe", () => {
    const src = read("lib/refunds.ts");
    for (const col of ["deposit_invoice_provider", "commitment_invoice_provider", "balance_invoice_provider"]) {
      expect(src, `the held snapshot no longer reads quotes.${col}`).toContain(col);
    }
  });
});
