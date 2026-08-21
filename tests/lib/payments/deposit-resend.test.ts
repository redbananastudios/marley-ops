import { describe, expect, it } from "vitest";

import { canResendDepositInvoice, type DepositResendFacts } from "@/lib/payments/invoice-resend";

/**
 * Re-sending the deposit email puts a payment demand back in front of a real
 * customer, so these tests pin the refusals rather than the happy path. The one
 * that matters most is "already paid" — Peter's rule that a manual send must
 * stop once the money is in.
 */
const sendable: DepositResendFacts = {
  invoiceRaised: true,
  invoicedAmount: 100,
  bookingCancelled: false,
  hasCustomerEmail: true,
  depositPaid: false,
};

describe("canResendDepositInvoice", () => {
  it("sends an unpaid, raised deposit again", () => {
    expect(canResendDepositInvoice(sendable)).toEqual({ ok: true });
  });

  it("refuses once the deposit is paid — never chase settled money", () => {
    expect(canResendDepositInvoice({ ...sendable, depositPaid: true })).toEqual({
      ok: false,
      reason: "The deposit is already paid — nothing to send.",
    });
  });

  it("refuses when the paid state could not be read", () => {
    // A failed query is not evidence of "unpaid". Silence beats a wrong demand.
    expect(canResendDepositInvoice({ ...sendable, paidStateUnknown: true })).toEqual({
      ok: false,
      reason: "Could not check whether the deposit is already paid.",
    });
  });

  it("refuses before any invoice exists — raising one is a different action", () => {
    expect(canResendDepositInvoice({ ...sendable, invoiceRaised: false })).toEqual({
      ok: false,
      reason: "No deposit invoice has been raised yet — it retries by itself, or raise it in Zoho.",
    });
  });

  it("refuses on a cancelled booking", () => {
    expect(canResendDepositInvoice({ ...sendable, bookingCancelled: true })).toEqual({
      ok: false,
      reason: "This booking was cancelled — its deposit will not be asked for again.",
    });
  });

  it("refuses a legacy iMVE booking whose standard comms are still off", () => {
    expect(canResendDepositInvoice({ ...sendable, commsLocked: true })).toEqual({
      ok: false,
      reason: "This is a legacy iMVE booking — turn its standard comms on before emailing them.",
    });
  });

  it("refuses with no email address", () => {
    expect(canResendDepositInvoice({ ...sendable, hasCustomerEmail: false })).toEqual({
      ok: false,
      reason: "No email address on this job — add one first.",
    });
  });

  it.each([0, -5, Number.NaN])("refuses when the deposit figure is %s", (invoicedAmount) => {
    expect(canResendDepositInvoice({ ...sendable, invoicedAmount })).toEqual({
      ok: false,
      reason: "The deposit amount is not recorded — check the invoice in Zoho.",
    });
  });

  it("names the paid state ahead of a missing email — the money answer wins", () => {
    expect(
      canResendDepositInvoice({ ...sendable, depositPaid: true, hasCustomerEmail: false }),
    ).toEqual({ ok: false, reason: "The deposit is already paid — nothing to send." });
  });

  it("an unreadable paid state outranks the paid flag it could not confirm", () => {
    // Both set means the read failed and the stale copy said paid: report the
    // honest answer ("could not check"), never the one we could not verify.
    expect(
      canResendDepositInvoice({ ...sendable, depositPaid: true, paidStateUnknown: true }),
    ).toEqual({ ok: false, reason: "Could not check whether the deposit is already paid." });
  });

  it("a cancelled booking is refused even when everything else is in order", () => {
    expect(canResendDepositInvoice({ ...sendable, bookingCancelled: true, depositPaid: true })).toEqual({
      ok: false,
      reason: "This booking was cancelled — its deposit will not be asked for again.",
    });
  });
});
