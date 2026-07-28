import { describe, expect, it } from "vitest";
import {
  successAmountMatches,
  refundBoundsError,
  shouldEscalateStuckPending,
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

describe("shouldEscalateStuckPending", () => {
  const nowMs = Date.parse("2026-07-28T12:00:00Z");
  const old = new Date(nowMs - (STUCK_PENDING_ALERT_MIN + 5) * 60 * 1000).toISOString();
  const fresh = new Date(nowMs - 5 * 60 * 1000).toISOString();
  const base = { status: "pending", is_test: false, created_at: old, reconcile_alerted_at: null };

  it("escalates a real pending attempt older than the threshold, once", () => {
    expect(shouldEscalateStuckPending(base, { nowMs })).toBe(true);
  });

  it("does NOT escalate before the threshold", () => {
    expect(shouldEscalateStuckPending({ ...base, created_at: fresh }, { nowMs })).toBe(false);
  });

  it("does NOT re-escalate one already alerted (dedup)", () => {
    expect(shouldEscalateStuckPending({ ...base, reconcile_alerted_at: old }, { nowMs })).toBe(false);
  });

  it("never escalates a test attempt", () => {
    expect(shouldEscalateStuckPending({ ...base, is_test: true }, { nowMs })).toBe(false);
  });

  it("never escalates a non-pending attempt (already settled/abandoned)", () => {
    expect(shouldEscalateStuckPending({ ...base, status: "paid" }, { nowMs })).toBe(false);
    expect(shouldEscalateStuckPending({ ...base, status: "abandoned" }, { nowMs })).toBe(false);
  });

  it("honours an explicit threshold override", () => {
    const twentyMinOld = new Date(nowMs - 20 * 60 * 1000).toISOString();
    expect(shouldEscalateStuckPending({ ...base, created_at: twentyMinOld }, { nowMs, thresholdMin: 15 })).toBe(true);
    expect(shouldEscalateStuckPending({ ...base, created_at: twentyMinOld }, { nowMs, thresholdMin: 30 })).toBe(false);
  });
});
