import { describe, expect, it } from "vitest";

import { isKnownXeroStatus, ledgerStatusFromXero } from "@/lib/ledger/xero-status";
import { isRaised } from "@/lib/finance/invoices";

/**
 * These strings are read raw in eleven places across five files, including the
 * branch that marks a deposit PAID and the write into `storage_invoices.status`.
 * A wrong mapping here does not throw — it quietly tells the office a customer
 * has paid, or that they have not.
 */

const OWED = { amountPaid: 0, amountDue: 100 };
const TODAY = "2026-09-15";

describe("ledgerStatusFromXero — the unambiguous cases", () => {
  it("maps DRAFT and PAID straight through", () => {
    expect(ledgerStatusFromXero("DRAFT", OWED, TODAY)).toBe("draft");
    expect(ledgerStatusFromXero("PAID", { amountPaid: 100, amountDue: 0 }, TODAY)).toBe("paid");
  });

  /**
   * Both terminal, and every place the app excludes `void` means "no longer
   * money owed" — which is exactly what a deleted draft is.
   */
  it("maps VOIDED and DELETED to void", () => {
    expect(ledgerStatusFromXero("VOIDED", OWED, TODAY)).toBe("void");
    expect(ledgerStatusFromXero("DELETED", OWED, TODAY)).toBe("void");
  });

  /** Awaiting internal approval: raised in Xero, but owed by nobody yet. */
  it("maps SUBMITTED to draft, not sent", () => {
    expect(ledgerStatusFromXero("SUBMITTED", OWED, TODAY)).toBe("draft");
  });
});

/**
 * AUTHORISED is Xero's "raised and owed" and covers three of ours. This is
 * where the mapping earns its keep — the distinction lives in a different
 * field, not in the status.
 */
describe("ledgerStatusFromXero — AUTHORISED splits three ways", () => {
  it("is sent when nothing has been paid and nothing is overdue", () => {
    expect(ledgerStatusFromXero("AUTHORISED", OWED, TODAY)).toBe("sent");
  });

  it("is partially_paid when some money has landed and some is still owed", () => {
    expect(
      ledgerStatusFromXero("AUTHORISED", { amountPaid: 40, amountDue: 60 }, TODAY),
    ).toBe("partially_paid");
  });

  /**
   * The boundary that matters: testing `amountPaid > 0` alone would report a
   * fully-settled invoice as partially paid in the window before Xero moves it
   * to PAID — an invoice the office would then chase.
   */
  it("is NOT partially_paid once the balance reaches zero", () => {
    expect(
      ledgerStatusFromXero("AUTHORISED", { amountPaid: 100, amountDue: 0 }, TODAY),
    ).not.toBe("partially_paid");
  });

  it("is overdue once the due date has passed", () => {
    expect(
      ledgerStatusFromXero("AUTHORISED", { ...OWED, dueDate: "2026-09-14" }, TODAY),
    ).toBe("overdue");
  });

  it("is not overdue on the due date itself", () => {
    expect(
      ledgerStatusFromXero("AUTHORISED", { ...OWED, dueDate: TODAY }, TODAY),
    ).toBe("sent");
  });

  /**
   * `createInvoice` sets no DueDate today, so this is the live shape until
   * gate 10 brings client terms. Stated as a test rather than left implicit:
   * a Xero invoice simply never reads overdue until then.
   */
  it("is never overdue when no due date was set", () => {
    expect(ledgerStatusFromXero("AUTHORISED", { ...OWED, dueDate: null }, TODAY)).toBe("sent");
    expect(ledgerStatusFromXero("AUTHORISED", OWED, TODAY)).toBe("sent");
  });

  /** Partial payment outranks overdue — the pill people act on is "some money came in". */
  it("prefers partially_paid over overdue when both apply", () => {
    expect(
      ledgerStatusFromXero("AUTHORISED", { amountPaid: 40, amountDue: 60, dueDate: "2026-01-01" }, TODAY),
    ).toBe("partially_paid");
  });
});

describe("ledgerStatusFromXero — what it refuses to invent", () => {
  /**
   * Xero has only `SentToContact`, which means "we marked it sent", not "the
   * customer opened it". Synthesising `viewed` would put a stronger claim on
   * the /finance pill than the data supports.
   */
  it("never produces 'viewed' from any input", () => {
    const every = ["DRAFT", "SUBMITTED", "DELETED", "AUTHORISED", "PAID", "VOIDED"];
    for (const s of every) {
      for (const amounts of [OWED, { amountPaid: 50, amountDue: 50 }, { amountPaid: 100, amountDue: 0 }]) {
        expect(ledgerStatusFromXero(s, amounts, TODAY)).not.toBe("viewed");
      }
    }
  });

  /**
   * The rule the whole `LedgerStatus` type exists for: an unknown money status
   * is passed through verbatim, never coerced. Coercing is a guess about
   * whether a customer has paid, and the pill that would have shown the guess
   * was wrong is the one the coercion just made look normal.
   */
  it("returns an unrecognised status verbatim instead of guessing", () => {
    expect(ledgerStatusFromXero("SOMETHING_NEW", OWED, TODAY)).toBe("SOMETHING_NEW");
    expect(ledgerStatusFromXero("", OWED, TODAY)).toBe("");
  });

  /** Case matters — Xero is uppercase, and a lowercase 'paid' is not Xero's. */
  it("does not accept our own vocabulary as input", () => {
    expect(ledgerStatusFromXero("paid", OWED, TODAY)).toBe("paid");
    expect(isKnownXeroStatus("paid")).toBe(false);
  });
});

describe("isKnownXeroStatus", () => {
  it("recognises all six documented statuses, AUTHORISED included", () => {
    // AUTHORISED is the one the spec's own _autodocs summary omits, and it is
    // the status almost every live invoice sits in.
    for (const s of ["DRAFT", "SUBMITTED", "DELETED", "AUTHORISED", "PAID", "VOIDED"]) {
      expect(isKnownXeroStatus(s)).toBe(true);
    }
  });

  it("rejects anything else, so the adapter can log rather than pass it silently", () => {
    expect(isKnownXeroStatus("APPROVED")).toBe(false);
    expect(isKnownXeroStatus("")).toBe(false);
  });
});

/**
 * The mapping is only correct if the rest of the app agrees with it, so assert
 * against the real consumer rather than against my reading of it.
 */
describe("the mapped values satisfy the app's existing money predicates", () => {
  it("treats a Xero-raised invoice as raised, and a voided or draft one as not", () => {
    expect(isRaised(ledgerStatusFromXero("AUTHORISED", OWED, TODAY))).toBe(true);
    expect(isRaised(ledgerStatusFromXero("PAID", { amountPaid: 100, amountDue: 0 }, TODAY))).toBe(true);
    expect(isRaised(ledgerStatusFromXero("VOIDED", OWED, TODAY))).toBe(false);
    expect(isRaised(ledgerStatusFromXero("DELETED", OWED, TODAY))).toBe(false);
    expect(isRaised(ledgerStatusFromXero("DRAFT", OWED, TODAY))).toBe(false);
    expect(isRaised(ledgerStatusFromXero("SUBMITTED", OWED, TODAY))).toBe(false);
  });
});
