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
  // resendBalanceInvoiceFlow always passes false here, on purpose — see the
  // comment where it builds these facts. The lock governs Marley's automated
  // correspondence; collecting a final invoice from a legacy iMVE customer is
  // an operator action the office is expected to take.
  commsLocked: false,
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

  it("a PAID balance outranks the comms lock — the money answer ends the conversation", () => {
    // Lock-first would tell the office to turn standard comms on, lifting
    // automation on a finished job, only for them to find nothing to send.
    // This pins the shared ladder's ORDER. It is not evidence about live data:
    // the balance flow passes commsLocked: false, so this pairing does not
    // arise on that rail — it bites on deposit and commitment.
    expect(canResendBalanceInvoice({ ...sendable, balancePaid: true, commsLocked: true })).toEqual({
      ok: false,
      reason: "The balance is already paid — nothing to send.",
    });
  });

  it("the lock rung still refuses an UNPAID balance when a caller arms it", () => {
    // The rung was dead on this rail until 2026-08-21 — commsLocked was an
    // optional field the balance flow never passed, so `undefined` read as
    // "not locked" while the copy below sat in the file implying otherwise.
    // The omission is now deliberate and typed rather than accidental; this
    // proves the rung itself works, so arming it stays a one-line change.
    expect(canResendBalanceInvoice({ ...sendable, commsLocked: true })).toEqual({
      ok: false,
      reason: "This is a legacy iMVE booking — turn its standard comms on before emailing them.",
    });
  });
});
