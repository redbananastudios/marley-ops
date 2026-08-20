import { describe, expect, it } from "vitest";

import { canResendBalanceInvoice, type BalanceResendFacts } from "@/lib/payments/balance-resend";

/**
 * Re-sending a final invoice puts a demand for four figures back in front of a
 * real customer, so these tests pin the refusals rather than the happy path.
 * The one that matters most is "already paid" — Peter's rule that a manual send
 * must stop once the money is in.
 */
const sendable: BalanceResendFacts = {
  invoiceRaised: true,
  invoicedAmount: 740,
  bookingCancelled: false,
  hasCustomerEmail: true,
  balancePaid: false,
};

describe("canResendBalanceInvoice", () => {
  it("sends an unpaid, raised invoice again", () => {
    expect(canResendBalanceInvoice(sendable)).toEqual({ ok: true });
  });

  it("refuses once the balance is paid — never chase settled money", () => {
    expect(canResendBalanceInvoice({ ...sendable, balancePaid: true })).toEqual({
      ok: false,
      reason: "The balance is already paid — nothing to send.",
    });
  });

  it("refuses when the paid state could not be read", () => {
    // A failed query is not evidence of "unpaid". Silence beats a wrong demand.
    expect(canResendBalanceInvoice({ ...sendable, paidStateUnknown: true })).toEqual({
      ok: false,
      reason: "Could not check whether the balance is already paid.",
    });
  });

  it("refuses before any invoice exists — creating one is a different action", () => {
    expect(canResendBalanceInvoice({ ...sendable, invoiceRaised: false })).toEqual({
      ok: false,
      reason: "No final invoice has been raised yet — create it first.",
    });
  });

  it("refuses on a cancelled booking", () => {
    expect(canResendBalanceInvoice({ ...sendable, bookingCancelled: true })).toEqual({
      ok: false,
      reason: "This booking was cancelled — its final invoice will not be sent again.",
    });
  });

  it("refuses with no email address", () => {
    expect(canResendBalanceInvoice({ ...sendable, hasCustomerEmail: false })).toEqual({
      ok: false,
      reason: "No email address on this job — add one first.",
    });
  });

  it.each([0, -5, Number.NaN])("refuses when the invoiced figure is %s", (invoicedAmount) => {
    expect(canResendBalanceInvoice({ ...sendable, invoicedAmount })).toEqual({
      ok: false,
      reason: "The invoiced balance is not recorded — check the invoice in Zoho.",
    });
  });

  it("names the paid state ahead of a missing email — the money answer wins", () => {
    const verdict = canResendBalanceInvoice({
      ...sendable,
      balancePaid: true,
      hasCustomerEmail: false,
    });
    expect(verdict).toEqual({ ok: false, reason: "The balance is already paid — nothing to send." });
  });

  it("a cancelled booking is refused even when everything else is in order", () => {
    expect(canResendBalanceInvoice({ ...sendable, bookingCancelled: true, balancePaid: true })).toEqual(
      { ok: false, reason: "This booking was cancelled — its final invoice will not be sent again." },
    );
  });
});
