import { describe, expect, it } from "vitest";
import {
  buildDepositReceivedEmailHtml,
  depositReceivedTemplateVars,
} from "@/lib/comms/payment-email";

/**
 * Gate 9a small jobs take ONE payment: at or under the small-job threshold the
 * acceptance ask IS the gross, the commitment clamps to 0 and no balance
 * invoice ever raises. markDepositPaid computes `balanceAmount:
 * balanceDue(agreed, deposit)` — which is exactly £0 for these — and the
 * receipt then told a paid-in-full customer "Your remaining balance is due 24
 * hours before your move": a promise of an invoice that will never come, on
 * both the in-repo builder and the Resend-template variable path.
 *
 * The three-way rule this pins:
 *   > 0   → the existing due line, BYTE-IDENTICAL (residential control);
 *   = 0   → known-zero: the receipt says settled / nothing more to pay;
 *   null  → unknown: the existing generic line, BYTE-IDENTICAL (a missing
 *           figure must not be read as "nothing owed").
 */

const meta = (balanceAmount: number | null) => ({
  firstName: "Sam",
  quoteRef: "MMR900",
  amount: 120,
  moveDateLabel: "Monday 14 September",
  balanceAmount,
});

const DUE_LINE = (amt: string) =>
  `Your remaining balance of <strong style="color:#1A1A1A;">${amt}</strong> is due 24 hours before your move, unless we've agreed otherwise.`;
const GENERIC_LINE = `Your remaining balance is due 24 hours before your move, unless we've agreed otherwise.`;

describe("deposit receipt — a paid-in-full small job reads settled, not owing", () => {
  it("builder: £0 balance says settled and drops every 'remaining balance' promise", () => {
    const html = buildDepositReceivedEmailHtml(meta(0));
    expect(html).not.toContain("remaining balance");
    expect(html).toContain("settles your booking in full");
    expect(html).toContain("nothing more to pay");
  });

  it("template vars: BALANCE_LINE agrees with the builder on £0", () => {
    const vars = depositReceivedTemplateVars(meta(0));
    expect(vars.BALANCE_LINE).not.toContain("remaining balance");
    expect(vars.BALANCE_LINE).toContain("settles your booking in full");
  });

  it("control: a real remaining balance keeps the due line byte-identical", () => {
    const html = buildDepositReceivedEmailHtml(meta(340));
    expect(html).toContain(DUE_LINE("£340"));
    const vars = depositReceivedTemplateVars(meta(340));
    expect(vars.BALANCE_LINE).toBe(DUE_LINE("£340"));
  });

  it("control: an UNKNOWN balance keeps the generic line byte-identical — null is not £0", () => {
    const html = buildDepositReceivedEmailHtml(meta(null));
    expect(html).toContain(GENERIC_LINE);
    const vars = depositReceivedTemplateVars(meta(null));
    expect(vars.BALANCE_LINE).toBe(GENERIC_LINE);
  });
});
