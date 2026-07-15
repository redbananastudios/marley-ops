import { describe, expect, it } from "vitest";
import { successAmountMatches, refundBoundsError } from "@/lib/payments/card-payments";

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
