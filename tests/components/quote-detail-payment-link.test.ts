import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paymentLinkFor, type PaymentLinkQuote } from "@/lib/payments/payment-link";

/**
 * Gate 9d (PRD §3.10) names TWO office surfaces for "Send payment link" — the
 * quote detail AND /bookings — and it shipped on /bookings only. The office
 * takes the call on the quote they already have open (that is where the figure
 * and the ref are), found no action there, and either went hunting the booking
 * row or did the thing the feature exists to prevent: took the card number
 * down the phone.
 *
 * The gate travels with it. Eligibility is the same pure rule
 * (`paymentLinkFor`) over the same two-switch card verdict
 * (`cardPaymentsAvailable`, global AND brand — PRD §11.10), so a brand with
 * card switched off still sees nothing, on a page whose every other rail says
 * bank transfer.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const SRC = read("app/(dashboard)/quotes/[id]/page.tsx");

describe("quote detail offers the payment link", () => {
  it("renders the shared button, not a second implementation", () => {
    at(SRC, "SendPaymentLinkButton", "the shared payment-link button");
    expect(SRC, "the action must not be re-implemented here").not.toContain("sendPaymentLinkAction");
  });

  it("gates on the pure rule rather than a local status check", () => {
    at(SRC, "paymentLinkFor(", "the eligibility rule");
  });

  it("resolves card availability through the two-switch helper", () => {
    const helper = at(SRC, "cardPaymentsAvailable(", "the two-switch card verdict");
    // Asked of THIS quote's brand — a global-only check is the QA-20260826-07
    // defect that made brands.card_payments_enabled a dead control.
    expect(SRC.slice(helper, helper + 60), "card availability is not asked per brand").toContain("quote.brand");
  });

  it("never offers it on a commercial quote, which has no deposit rung", () => {
    at(SRC, 'paymentPolicy === "commercial"', "the commercial exclusion");
  });
});

describe("the rule the quote detail now consults", () => {
  const base: PaymentLinkQuote = {
    status: "accepted",
    deposit_paid_at: null,
    deposit_amount: 100,
    booking_cancelled_at: null,
    source: null,
    standard_comms_at: null,
  };

  it("refuses a card-off brand", () => {
    expect(paymentLinkFor(base, false, 100).ok).toBe(false);
  });

  it("offers the accepted, unpaid ask", () => {
    expect(paymentLinkFor(base, true, 100)).toEqual({ ok: true, amountPence: 10_000 });
  });
});
