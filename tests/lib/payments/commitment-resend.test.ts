import { describe, expect, it } from "vitest";

import { canResendCommitmentInvoice, type CommitmentResendFacts } from "@/lib/payments/invoice-resend";

/**
 * The 25% commitment is the largest single ask before move day, so these tests
 * pin the refusals rather than the happy path. "Already paid" is Peter's rule;
 * "could not check" is the house rule that a failed read is not evidence of
 * unpaid.
 */
const sendable: CommitmentResendFacts = {
  invoiceRaised: true,
  invoicedAmount: 473.8,
  bookingCancelled: false,
  hasCustomerEmail: true,
  commitmentPaid: false,
};

describe("canResendCommitmentInvoice", () => {
  it("sends an unpaid, raised commitment invoice again", () => {
    expect(canResendCommitmentInvoice(sendable)).toEqual({ ok: true });
  });

  it("refuses once the commitment is paid — never chase settled money", () => {
    expect(canResendCommitmentInvoice({ ...sendable, commitmentPaid: true })).toEqual({
      ok: false,
      reason: "The commitment is already paid — nothing to send.",
    });
  });

  it("refuses when the paid state could not be read", () => {
    expect(canResendCommitmentInvoice({ ...sendable, paidStateUnknown: true })).toEqual({
      ok: false,
      reason: "Could not check whether the commitment is already paid.",
    });
  });

  it("refuses before any invoice exists — the date confirmation raises it", () => {
    expect(canResendCommitmentInvoice({ ...sendable, invoiceRaised: false })).toEqual({
      ok: false,
      reason:
        "No commitment invoice has been raised yet — it is raised when the customer confirms their move date.",
    });
  });

  it("refuses on a cancelled booking", () => {
    expect(canResendCommitmentInvoice({ ...sendable, bookingCancelled: true })).toEqual({
      ok: false,
      reason: "This booking was cancelled — its commitment invoice will not be sent again.",
    });
  });

  it("refuses a legacy iMVE booking whose standard comms are still off", () => {
    // A commitment invoice can exist on a legacy booking (comms were switched
    // ON, the date was confirmed, then the office switched them off again), and
    // the lock exists precisely to stop Marley's standard email reaching a
    // customer who bought under the old system's terms.
    expect(canResendCommitmentInvoice({ ...sendable, commsLocked: true })).toEqual({
      ok: false,
      reason: "This is a legacy iMVE booking — turn its standard comms on before emailing them.",
    });
  });

  it("refuses with no email address", () => {
    expect(canResendCommitmentInvoice({ ...sendable, hasCustomerEmail: false })).toEqual({
      ok: false,
      reason: "No email address on this job — add one first.",
    });
  });

  it.each([0, -5, Number.NaN])("refuses when the invoiced figure is %s", (invoicedAmount) => {
    expect(canResendCommitmentInvoice({ ...sendable, invoicedAmount })).toEqual({
      ok: false,
      reason: "The invoiced commitment is not recorded — check the invoice in Zoho.",
    });
  });

  it("names the paid state ahead of a missing email — the money answer wins", () => {
    expect(
      canResendCommitmentInvoice({ ...sendable, commitmentPaid: true, hasCustomerEmail: false }),
    ).toEqual({ ok: false, reason: "The commitment is already paid — nothing to send." });
  });

  it("an unreadable paid state outranks the paid flag it could not confirm", () => {
    expect(
      canResendCommitmentInvoice({ ...sendable, commitmentPaid: true, paidStateUnknown: true }),
    ).toEqual({ ok: false, reason: "Could not check whether the commitment is already paid." });
  });

  it("the comms lock outranks a missing figure — a locked booking is not emailed at all", () => {
    expect(canResendCommitmentInvoice({ ...sendable, commsLocked: true, invoicedAmount: 0 })).toEqual({
      ok: false,
      reason: "This is a legacy iMVE booking — turn its standard comms on before emailing them.",
    });
  });
});
