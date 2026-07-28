import { describe, expect, it } from "vitest";
import { buildRefundVerifyAlert, buildCreditNoteReminder } from "@/lib/payments/refund-vat";

/**
 * Money-critical VAT-reversal wording. The automation moves real money and posts
 * to the live VAT return, so the accounts@ VERIFY email (happy path) and the
 * manual FALLBACK reminder (Zoho failed) must each say exactly the right thing —
 * these lock that so it can't silently drift.
 */

describe("buildRefundVerifyAlert", () => {
  const base = {
    quoteRef: "MM-260728-001",
    amountPence: 1500,
    creditNoteNumber: "CN-00042",
    invoiceNumber: "INV-000038",
    mode: "creditcard" as const,
    voided: false,
    alreadyRefunded: false,
  };

  it("asks accounts to verify, naming amount, credit note, invoice + the VAT reversal", () => {
    const r = buildRefundVerifyAlert(base);
    expect(r.subject).toContain("VERIFY");
    expect(r.subject).toContain("£15.00");
    expect(r.subject).toContain("MM-260728-001");
    const body = r.lines.join(" ");
    expect(body).toContain("£15.00");
    expect(body).toContain("CN-00042");
    expect(body).toContain("INV-000038");
    expect(body.toLowerCase()).toContain("vat is reversed");
    expect(body).toContain("back to the card");
    expect(body).toContain("takepayments");
  });

  it("uses bank-transfer wording for a BACS refund", () => {
    const r = buildRefundVerifyAlert({ ...base, mode: "banktransfer" });
    const body = r.lines.join(" ");
    expect(body).toContain("by bank transfer");
    expect(body).toContain("the bank");
    expect(body).not.toContain("takepayments");
  });

  it("says voided for a card void, and flags an already-recorded refund", () => {
    const r = buildRefundVerifyAlert({ ...base, voided: true, alreadyRefunded: true });
    expect(r.subject).toContain("voided");
    expect(r.lines.join(" ").toLowerCase()).toContain("already recorded");
  });
});

describe("buildCreditNoteReminder (fallback when the automation failed)", () => {
  const base = {
    quoteRef: "MM-260728-001",
    invoiceNumber: "INV-000038",
    amountPence: 1500,
    voided: false,
    mode: "creditcard" as const,
  };

  it("tells accounts to RAISE + refund a credit note when none exists yet", () => {
    const r = buildCreditNoteReminder({ ...base, error: "Zoho token refresh failed" });
    const body = r.lines.join(" ");
    expect(body).toContain("£15.00");
    expect(body).toContain("did NOT complete");
    expect(body).toContain("Zoho token refresh failed");
    expect(body.toLowerCase()).toContain("raise a credit note");
    expect(body.toLowerCase()).toContain("refund it");
    expect(body).toContain("INV-000038");
    expect(r.followUpNotes).toContain("£15.00");
    expect(r.followUpNotes.toLowerCase()).toContain("reverse the vat");
  });

  it("when a credit note WAS raised but its refund failed, says record it — never raise a second", () => {
    const r = buildCreditNoteReminder({ ...base, existingCreditNoteNumber: "CN-00042" });
    const body = r.lines.join(" ");
    expect(body).toContain("CN-00042");
    expect(body).toContain("RECORD THE REFUND");
    expect(body.toLowerCase()).toContain("do not raise a second");
    expect(r.followUpNotes).toContain("CN-00042");
    expect(r.followUpNotes.toLowerCase()).toContain("do not raise a second");
  });

  it("uses void wording and a safe fallback when there is no invoice number", () => {
    const r = buildCreditNoteReminder({ ...base, invoiceNumber: null, voided: true });
    expect(r.subject).toContain("voided");
    expect(r.lines.join(" ")).toContain("the deposit invoice for this quote");
    expect(r.followUpNotes).toContain("the deposit invoice");
  });

  it("keeps the forfeited-deposit nuance explicit — only money-back reverses VAT", () => {
    const r = buildCreditNoteReminder(base);
    expect(r.lines.join(" ").toLowerCase()).toContain("forfeited");
    expect(r.followUpNotes.toLowerCase()).toContain("forfeited");
  });
});
