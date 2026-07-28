import { describe, expect, it } from "vitest";
import {
  successAmountMatches,
  refundBoundsError,
  shouldEscalateStuckPayment,
  terminalStatusToReturnState,
  buildCreditNoteReminder,
  STUCK_PENDING_ALERT_MIN,
} from "@/lib/payments/card-payments";

/**
 * Pure money guards for the card-payment lifecycle. The DB-coupled flow
 * (settle/refund/reconcile) is proven live against the takepayments simulator
 * per the PRD; these lock the arithmetic that decides whether real money moves.
 */

describe("successAmountMatches", () => {
  it("accepts an exact pence match", () => {
    expect(successAmountMatches("10000", 10000)).toBe(true);
    expect(successAmountMatches(10000, 10000)).toBe(true);
  });

  it("rejects a tampered / wrong amount (the mismatch alarm path)", () => {
    expect(successAmountMatches("1", 10000)).toBe(false);
    expect(successAmountMatches("9999", 10000)).toBe(false);
    expect(successAmountMatches("10001", 10000)).toBe(false);
  });

  it("rejects non-numeric or missing amounts", () => {
    expect(successAmountMatches(undefined, 10000)).toBe(false);
    expect(successAmountMatches("", 10000)).toBe(false);
    expect(successAmountMatches("abc", 10000)).toBe(false);
    expect(successAmountMatches(null, 10000)).toBe(false);
  });
});

describe("refundBoundsError", () => {
  const ok = {
    status: "paid",
    hasXref: true,
    remainingPence: 10000,
    amountPence: 10000,
    reason: "Booking cancelled",
  };

  it("allows a valid full refund", () => {
    expect(refundBoundsError(ok)).toBeNull();
  });

  it("allows a partial refund within the remaining balance", () => {
    expect(refundBoundsError({ ...ok, amountPence: 2500 })).toBeNull();
  });

  it("blocks refunds on a non-refundable status", () => {
    expect(refundBoundsError({ ...ok, status: "pending" })).toMatch(/paid card payment/);
    expect(refundBoundsError({ ...ok, status: "refunded" })).toMatch(/paid card payment/);
  });

  it("allows a top-up refund on a partially-refunded row", () => {
    expect(refundBoundsError({ ...ok, status: "partially_refunded", remainingPence: 5000, amountPence: 5000 })).toBeNull();
  });

  it("blocks when there is no gateway reference to refund against", () => {
    expect(refundBoundsError({ ...ok, hasXref: false })).toMatch(/gateway reference/);
  });

  it("blocks over-refunding past the remaining balance", () => {
    expect(refundBoundsError({ ...ok, remainingPence: 7500, amountPence: 10000 })).toMatch(/between 1p/);
  });

  it("blocks zero, negative and non-integer amounts", () => {
    expect(refundBoundsError({ ...ok, amountPence: 0 })).toMatch(/between 1p/);
    expect(refundBoundsError({ ...ok, amountPence: -100 })).toMatch(/between 1p/);
  });

  it("requires a reason", () => {
    expect(refundBoundsError({ ...ok, reason: "   " })).toMatch(/reason is required/);
  });
});

describe("shouldEscalateStuckPayment", () => {
  const nowMs = Date.parse("2026-07-28T12:00:00Z");
  const old = new Date(nowMs - (STUCK_PENDING_ALERT_MIN + 5) * 60 * 1000).toISOString();
  const fresh = new Date(nowMs - 5 * 60 * 1000).toISOString();
  const base = { status: "pending", is_test: false, created_at: old, reconcile_alerted_at: null };

  it("escalates a real pending attempt older than the threshold, once", () => {
    expect(shouldEscalateStuckPayment(base, { nowMs })).toBe(true);
  });

  it("ALSO escalates a superseded (abandoned) attempt — its original session may have been charged", () => {
    // The two-tab hole: an abandoned row with no xref whose original gateway
    // session may still have completed + charged is just as un-queryable as a
    // stuck pending one, so it must reach a human too.
    expect(shouldEscalateStuckPayment({ ...base, status: "abandoned" }, { nowMs })).toBe(true);
  });

  it("does NOT escalate before the threshold (pending or abandoned)", () => {
    expect(shouldEscalateStuckPayment({ ...base, created_at: fresh }, { nowMs })).toBe(false);
    expect(shouldEscalateStuckPayment({ ...base, status: "abandoned", created_at: fresh }, { nowMs })).toBe(false);
  });

  it("does NOT re-escalate one already alerted (dedup)", () => {
    expect(shouldEscalateStuckPayment({ ...base, reconcile_alerted_at: old }, { nowMs })).toBe(false);
    expect(shouldEscalateStuckPayment({ ...base, status: "abandoned", reconcile_alerted_at: old }, { nowMs })).toBe(false);
  });

  it("never escalates a test attempt", () => {
    expect(shouldEscalateStuckPayment({ ...base, is_test: true }, { nowMs })).toBe(false);
    expect(shouldEscalateStuckPayment({ ...base, status: "abandoned", is_test: true }, { nowMs })).toBe(false);
  });

  it("never escalates an already-settled/terminal attempt", () => {
    for (const status of ["paid", "failed", "needs_review", "refunded", "voided", "partially_refunded"]) {
      expect(shouldEscalateStuckPayment({ ...base, status }, { nowMs })).toBe(false);
    }
  });

  it("honours an explicit threshold override", () => {
    const twentyMinOld = new Date(nowMs - 20 * 60 * 1000).toISOString();
    expect(shouldEscalateStuckPayment({ ...base, created_at: twentyMinOld }, { nowMs, thresholdMin: 15 })).toBe(true);
    expect(shouldEscalateStuckPayment({ ...base, created_at: twentyMinOld }, { nowMs, thresholdMin: 30 })).toBe(false);
  });
});

describe("terminalStatusToReturnState", () => {
  // The money-critical redirect table: a race-loser browser-return must reflect
  // the WINNER's real outcome. Only a genuinely paid row may show success — a
  // whitelist, so a new terminal status can never silently fall through to a
  // false "you paid" screen (the bug that shipped as the abandoned/pending
  // fall-through and was caught in this hardening pass).
  it("shows success ONLY for a genuinely paid row", () => {
    expect(terminalStatusToReturnState("paid")).toBe("ok");
  });

  it("shows the retry (failed) page for a decline", () => {
    expect(terminalStatusToReturnState("failed")).toBe("failed");
  });

  it("shows the call-us (error) page for EVERY other status — never a false success", () => {
    for (const status of [
      "needs_review",
      "abandoned",
      "pending",
      "voided",
      "refunded",
      "partially_refunded",
      "something_new",
    ]) {
      expect(terminalStatusToReturnState(status)).toBe("error");
    }
  });
});

describe("buildCreditNoteReminder", () => {
  // The VAT guard-rail on a card refund: because raising the Zoho credit note is
  // a manual step, this reminder is the only thing standing between "refunded in
  // app" and "output VAT actually reclaimed". These lock the money-critical
  // wording so it can't silently drift to something a human would ignore.
  it("tells accounts to reverse the VAT via a credit note, naming the amount + invoice", () => {
    const r = buildCreditNoteReminder({
      quoteRef: "MM-260728-001",
      invoiceNumber: "INV-000038",
      invoiceUrl: "https://invoice.zoho.eu/…/38",
      amountPence: 1500,
      voided: false,
    });
    expect(r.subject).toContain("VAT reversal");
    expect(r.subject).toContain("MM-260728-001");
    const body = r.lines.join(" ");
    expect(body).toContain("£15.00");
    expect(body).toContain("refunded");
    expect(body).toContain("credit note");
    expect(body).toContain("INV-000038");
    expect(body.toLowerCase()).toContain("vat");
    expect(r.followUpNotes).toContain("£15.00");
    expect(r.followUpNotes).toContain("INV-000038");
    expect(r.followUpNotes.toLowerCase()).toContain("reclaim");
  });

  it("uses void wording and a safe fallback when there is no invoice number", () => {
    const r = buildCreditNoteReminder({
      quoteRef: "MM-1",
      invoiceNumber: null,
      invoiceUrl: null,
      amountPence: 12000,
      voided: true,
    });
    expect(r.subject).toContain("voided");
    expect(r.lines.join(" ")).toContain("£120.00");
    // No invoice number → a readable generic reference, never a broken blank.
    expect(r.lines.join(" ")).toContain("the deposit invoice for this quote");
    expect(r.followUpNotes).toContain("the deposit invoice");
  });

  it("keeps the forfeited-deposit nuance explicit — only money-back reverses VAT", () => {
    const r = buildCreditNoteReminder({
      quoteRef: "MM-2",
      invoiceNumber: "INV-1",
      invoiceUrl: null,
      amountPence: 5000,
      voided: false,
    });
    expect(r.lines.join(" ").toLowerCase()).toContain("forfeited");
    expect(r.followUpNotes.toLowerCase()).toContain("forfeited");
  });
});
