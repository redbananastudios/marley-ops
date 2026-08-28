import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paymentLinkFor, type PaymentLinkQuote } from "@/lib/payments/payment-link";

/**
 * Gate 9d (PRD §3.10) — the office "Send payment link" action.
 *
 * The scope decision is the load-bearing part of this rule and is asserted
 * below rather than left in a comment: the link covers the ACCEPTANCE ASK only.
 * Commitment and balance are BACS/cash by a pricing decision this codebase
 * defends elsewhere by throwing (lib/ledger/xero-config.ts, Peter 2026-07-09),
 * and a takepayments link would reverse it through a different door.
 */

const base: PaymentLinkQuote = {
  status: "accepted",
  deposit_paid_at: null,
  deposit_amount: 100,
  booking_cancelled_at: null,
  source: null,
  standard_comms_at: null,
};

const DEFAULT_DEPOSIT = 100;

describe("paymentLinkFor", () => {
  it("offers the acceptance ask on an accepted, unpaid, card-enabled quote", () => {
    const v = paymentLinkFor(base, true, DEFAULT_DEPOSIT);
    expect(v).toEqual({ ok: true, amountPence: 10_000 });
  });

  it("follows the ask amount, whatever gates 9a and 9b made it", () => {
    // Gate 9a: a small job's acceptance ask IS the whole price.
    expect(paymentLinkFor({ ...base, deposit_amount: 120 }, true, DEFAULT_DEPOSIT)).toEqual({
      ok: true,
      amountPence: 12_000,
    });
    // Gate 9b: a late booking collapses to max(deposit, 25%).
    expect(paymentLinkFor({ ...base, deposit_amount: 500 }, true, DEFAULT_DEPOSIT)).toEqual({
      ok: true,
      amountPence: 50_000,
    });
    // No figure frozen on the quote falls back to the settings default, exactly
    // as startCardPayment resolves it — so the link quotes what the mint charges.
    expect(paymentLinkFor({ ...base, deposit_amount: null }, true, DEFAULT_DEPOSIT)).toEqual({
      ok: true,
      amountPence: 10_000,
    });
  });

  it("a brand with card off gets no link at all", () => {
    // cardOk is the caller's resolved cardPaymentsAvailable, which ANDs the
    // global kill switch, the brand switch and the takepayments credentials.
    // Offering a card channel to a brand whose every email says bank transfer
    // is the only route is the exact defect QA-20260826-07 fixed on /q.
    const v = paymentLinkFor(base, false, DEFAULT_DEPOSIT);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/card/i);
  });

  it("refuses every state where there is nothing to ask for", () => {
    const refused = (q: Partial<PaymentLinkQuote>) => paymentLinkFor({ ...base, ...q }, true, DEFAULT_DEPOSIT);
    // Not accepted yet — the customer has agreed to nothing.
    expect(refused({ status: "sent" }).ok).toBe(false);
    expect(refused({ status: "declined" }).ok).toBe(false);
    // Already paid: a second link would take the money twice.
    expect(refused({ deposit_paid_at: "2026-08-20T10:00:00Z" }).ok).toBe(false);
    // Cancelled.
    expect(refused({ booking_cancelled_at: "2026-08-20T10:00:00Z" }).ok).toBe(false);
    // Legacy iMVE: sold under the old system's terms, money moves are manual.
    expect(refused({ source: "imve", standard_comms_at: null }).ok).toBe(false);
    // ...but a legacy job switched onto standard comms is ordinary again.
    expect(refused({ source: "imve", standard_comms_at: "2026-08-01T09:00:00Z" }).ok).toBe(true);
    // No amount to charge.
    expect(paymentLinkFor({ ...base, deposit_amount: 0 }, true, 0).ok).toBe(false);
    expect(paymentLinkFor({ ...base, deposit_amount: -5 }, true, DEFAULT_DEPOSIT).ok).toBe(false);
  });

  it("every refusal says something the office can act on", () => {
    // A disabled button with no reason sends someone to ring a developer.
    for (const q of [
      { status: "sent" },
      { deposit_paid_at: "2026-08-20T10:00:00Z" },
      { booking_cancelled_at: "2026-08-20T10:00:00Z" },
      { source: "imve" },
    ] as Partial<PaymentLinkQuote>[]) {
      const v = paymentLinkFor({ ...base, ...q }, true, DEFAULT_DEPOSIT);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.reason.length).toBeGreaterThan(10);
    }
  });
});

/**
 * Source guard. Two invariants here are invisible to a type checker and both
 * have already been got wrong once in this codebase.
 */
describe("the payment-link call sites keep their guarantees", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  /** The action body only — the Settings panel elsewhere in this file reads the
   *  global switch legitimately, to DISPLAY it. */
  const sendPaymentLinkSrc = () => {
    const src = read("app/actions/card-payments.ts");
    const at = src.indexOf("export async function sendPaymentLinkAction(");
    expect(at, "sendPaymentLinkAction not found — rename it here too").toBeGreaterThan(-1);
    return src.slice(at);
  };

  it("the office action asks cardPaymentsAvailable rather than re-deriving the pair", () => {
    const src = sendPaymentLinkSrc();
    expect(src).toContain("cardPaymentsAvailable(admin, quote.brand)");
    // Reading either switch directly here would be a second, drifting copy of a
    // precedence rule that was already wrong once (QA-20260826-07 — the brand
    // switch was a dead control because /q consulted the global one alone).
    expect(src).not.toContain('card_payments_enabled');
    expect(src).not.toContain('business_settings');
  });

  it("the action gates on the pure rule, not on its own conditions", () => {
    const src = sendPaymentLinkSrc();
    expect(src).toContain("paymentLinkFor(quote, cardOk, settings.defaultDeposit)");
    expect(src).toContain("if (!verdict.ok) return { ok: false, error: verdict.reason };");
  });

  it("a settled card row is never routed by anything but its own kind", () => {
    const src = read("lib/payments/card-payments.ts");
    // markDepositPaid used to run for EVERY settled row regardless of kind,
    // while the check constraint already allowed 'balance'. Inert only while
    // nothing minted one; the moment something did, a capture would have flipped
    // the deposit paid instead of the rung actually paid.
    expect(src).toContain('if (row.kind !== "deposit") {');
    const guardAt = src.indexOf('if (row.kind !== "deposit") {');
    const markAt = src.indexOf("await markDepositPaid(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(guardAt);
  });
});
