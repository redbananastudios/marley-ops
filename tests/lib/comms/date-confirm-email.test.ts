import { describe, expect, it } from "vitest";
import {
  buildCommitmentReceivedEmailHtml,
  buildDateConfirmationEmailHtml,
  commitmentReceivedTemplateVars,
  dateConfirmationSms,
  dateConfirmationTemplateVars,
  type DateConfirmationMeta,
} from "@/lib/comms/date-confirm-email";
import { BANK_DETAILS } from "@/lib/comms/payment-email";
import { DATE_CONFIRM_ACKS } from "@/lib/signatures";

/**
 * Payments Policy v2 copy rules (docs/payments-policy-v2-prd.md):
 *  - the word "penalty" NEVER appears in customer-facing output;
 *  - amounts are VAT-inclusive gross, £-formatted;
 *  - held-money framing is "held against your original date, refunded if
 *    re-booked";
 *  - UK English, no em-dashes (house email rule).
 */

const NO_PENALTY = (s: string) => expect(s.toLowerCase()).not.toContain("penalty");
const NO_EM_DASH = (s: string) => expect(s).not.toMatch(/—/);

const meta: DateConfirmationMeta = {
  firstName: "Jane",
  quoteRef: "MMR042",
  moveDateLabel: "Monday 20 July",
  depositAmount: 100,
  commitmentAmount: 500,
  commitmentDueLabel: "Monday 13 July",
  invoiceNumber: "INV-000203",
  invoiceUrl: "https://zoho.example/invoice/203",
};

const zeroMeta: DateConfirmationMeta = {
  ...meta,
  commitmentAmount: 0,
  invoiceNumber: null,
  invoiceUrl: null,
};

describe("date-confirmation email", () => {
  const html = buildDateConfirmationEmailHtml(meta);

  it("carries the confirmed date, gross amounts and the due date", () => {
    expect(html).toContain("Monday 20 July");
    expect(html).toContain("£100"); // deposit, gross
    expect(html).toContain("£500"); // commitment, gross
    expect(html).toContain("Monday 13 July");
    expect(html).toContain("INV-000203");
    expect(html).toContain("MMR042");
  });

  it("states the non-refundable + counts-towards-final-bill position", () => {
    expect(html).toContain("non-refundable");
    expect(html).toContain("counts towards your final bill");
  });

  it("uses the held-against-your-date framing, never penalty language", () => {
    expect(html).toContain("held against your original date");
    expect(html).toContain("refunded in full if the day is re-booked");
    NO_PENALTY(html);
    NO_EM_DASH(html);
  });

  it("includes bank details with the plain quote reference", () => {
    expect(html).toContain(BANK_DETAILS.account);
    expect(html).toContain(BANK_DETAILS.sortCode);
    expect(html).toContain("MMR042");
  });

  it("late collapse: a missing due label reads as due now", () => {
    const nowHtml = buildDateConfirmationEmailHtml({ ...meta, commitmentDueLabel: null });
    expect(nowHtml).toContain("due now");
    NO_PENALTY(nowHtml);
  });

  it("zero-commitment variant: no invoice, no bank details, nothing to pay now", () => {
    const zero = buildDateConfirmationEmailHtml(zeroMeta);
    expect(zero).toContain("nothing more to pay right now");
    expect(zero).not.toContain(BANK_DETAILS.account);
    expect(zero).not.toContain("Commitment payment ·");
    expect(zero).toContain("non-refundable"); // confirmation still flips it
    NO_PENALTY(zero);
    NO_EM_DASH(zero);
  });

  it("escapes customer-controlled values", () => {
    const sneaky = buildDateConfirmationEmailHtml({
      ...meta,
      firstName: "<script>alert(1)</script>",
    });
    expect(sneaky).not.toContain("<script>alert(1)</script>");
  });
});

describe("date-confirmation template vars", () => {
  const vars = dateConfirmationTemplateVars(meta);

  it("provides the full variable set for the Resend template", () => {
    expect(Object.keys(vars).sort()).toEqual([
      "COMMITMENT_BLOCK",
      "CUSTOMER_FIRST_NAME",
      "DEPOSIT_AMOUNT",
      "HELD_POSITION_LINE",
      "MOVE_DATE_LABEL",
      "QUOTE_REF",
    ]);
    expect(vars.CUSTOMER_FIRST_NAME).toBe("Jane");
    expect(vars.DEPOSIT_AMOUNT).toBe("£100");
    expect(vars.COMMITMENT_BLOCK).toContain("£500");
    expect(vars.COMMITMENT_BLOCK).toContain("Monday 13 July");
  });

  it("keeps the copy rules in the template path too", () => {
    for (const v of Object.values(vars)) {
      NO_PENALTY(v);
    }
    expect(vars.HELD_POSITION_LINE).toContain("held against your original date");
    const zeroVars = dateConfirmationTemplateVars(zeroMeta);
    expect(zeroVars.COMMITMENT_BLOCK).toContain("nothing more to pay right now");
    expect(zeroVars.COMMITMENT_BLOCK).not.toContain(BANK_DETAILS.account);
  });
});

describe("date-confirmation SMS", () => {
  // Mirrors buildDateConfirmationEmailHtml's four branches off the same meta
  // shapes, so a mismatch between what the email and the SMS tell a customer
  // is caught here rather than live.
  it("commitment due: names the amount, due date and phone, no link", () => {
    const sms = dateConfirmationSms(meta);
    expect(sms).toContain("Jane");
    expect(sms).toContain("Monday 20 July");
    expect(sms).toContain("£500");
    expect(sms).toContain("Monday 13 July");
    expect(sms).toContain("01747 637070");
    expect(sms).not.toContain("http");
    NO_PENALTY(sms);
    NO_EM_DASH(sms);
  });

  it("late collapse: a missing due label reads as due now", () => {
    const sms = dateConfirmationSms({ ...meta, commitmentDueLabel: null });
    expect(sms).toContain("due now");
  });

  it("an already-issued, still-outstanding balance is named and due before move day", () => {
    const sms = dateConfirmationSms({
      ...zeroMeta,
      balanceInvoiced: 1400,
      balanceSettled: false,
    });
    expect(sms).toContain("£1,400");
    expect(sms).toContain("due before move day");
    expect(sms).not.toContain("commitment payment");
    NO_PENALTY(sms);
  });

  it("an already-issued, SETTLED balance reassures rather than asking again", () => {
    const sms = dateConfirmationSms({
      ...zeroMeta,
      balanceInvoiced: 1400,
      balanceSettled: true,
    });
    expect(sms).toContain("settled in full");
    expect(sms).toContain("nothing left to pay");
  });

  it("gate 9a paid-in-full: no balance or later invoice is promised", () => {
    const sms = dateConfirmationSms({ ...zeroMeta, depositAmount: 480, paidInFull: true });
    expect(sms).toContain("covers it in full");
    expect(sms).toContain("nothing more to pay");
    expect(sms).not.toContain("balance");
    NO_PENALTY(sms);
  });

  it("zero-commitment, no balance yet: nothing to pay right now", () => {
    const sms = dateConfirmationSms(zeroMeta);
    expect(sms).toContain("Nothing to pay right now");
    expect(sms).toContain("01747 637070");
    NO_PENALTY(sms);
  });

  it("no first name falls back to a generic greeting rather than blank", () => {
    const sms = dateConfirmationSms({ ...meta, firstName: null });
    expect(sms).toContain("Hi there,");
  });
});

describe("commitment-received email", () => {
  const html = buildCommitmentReceivedEmailHtml({
    firstName: "Jane",
    quoteRef: "MMR042",
    amount: 500,
    moveDateLabel: "Monday 20 July",
  });

  it("confirms the gross amount and the balance-next position", () => {
    expect(html).toContain("£500");
    expect(html).toContain("MMR042");
    expect(html).toContain("Monday 20 July");
    expect(html).toContain("counts towards your final bill");
    expect(html).toContain("before move day");
  });

  it("obeys the copy rules", () => {
    NO_PENALTY(html);
    NO_EM_DASH(html);
  });

  it("template vars are complete and escaped", () => {
    const vars = commitmentReceivedTemplateVars({
      firstName: "<b>Jane</b>",
      quoteRef: "MMR042",
      amount: 500,
      moveDateLabel: "Monday 20 July",
    });
    expect(Object.keys(vars).sort()).toEqual([
      "AMOUNT",
      "CUSTOMER_FIRST_NAME",
      "MOVE_DATE_LABEL",
      "QUOTE_REF",
      "RECEIPT_BLOCK",
    ]);
    expect(vars.AMOUNT).toBe("£500");
    // No receipt supplied here → the receipt block variable is empty.
    expect(vars.RECEIPT_BLOCK).toBe("");
    expect(vars.CUSTOMER_FIRST_NAME).not.toContain("<b>");
  });
});

describe("date-confirmation email — paid-in-full small job (gate 9a)", () => {
  // A small job's acceptance ask IS the gross: the commitment clamps to 0 AND
  // no balance will ever be invoiced. The plain zero-commitment copy ("the
  // balance is due before move day", "final invoice nearer the time") promises
  // that customer money movements that will never happen — `paidInFull` is the
  // caller's verdict that the frozen figures cover the whole job, mirroring
  // /q's paidInFull gate from the small-job settled-copy fix.
  const paidMeta: DateConfirmationMeta = {
    ...zeroMeta,
    depositAmount: 480,
    paidInFull: true,
  };

  it("says the booking is covered in full and promises no balance or later invoice", () => {
    const html = buildDateConfirmationEmailHtml(paidMeta);
    expect(html).toContain("covers your booking in full");
    expect(html).toContain("nothing more to pay");
    expect(html).not.toContain("nothing more to pay right now"); // no "right now" hedge — nothing is coming
    expect(html).not.toContain("balance");
    expect(html).not.toContain("final invoice nearer the time");
    expect(html).not.toContain(BANK_DETAILS.account);
    expect(html).toContain("non-refundable"); // confirmation still flips the held position
    NO_PENALTY(html);
    NO_EM_DASH(html);
  });

  it("the template-var rail carries the same paid-in-full copy", () => {
    const vars = dateConfirmationTemplateVars(paidMeta);
    expect(vars.COMMITMENT_BLOCK).toContain("covers your booking in full");
    expect(vars.COMMITMENT_BLOCK).not.toContain("balance");
    expect(vars.COMMITMENT_BLOCK).not.toContain(BANK_DETAILS.account);
    for (const v of Object.values(vars)) NO_PENALTY(v);
  });

  it("absent flag keeps today's exact zero-commitment copy for jobs that DO carry a balance", () => {
    const zero = buildDateConfirmationEmailHtml(zeroMeta);
    expect(zero).toContain("nothing more to pay right now");
    expect(zero).toContain("Your remaining balance is due in full before move day");
    expect(zero).not.toContain("covers your booking in full");
  });
});

describe("date-confirmation email — an already-issued final balance (PRD §3.10 Addition 2)", () => {
  // A late booking raises AND EMAILS the -BAL invoice at ACCEPTANCE, and
  // ensureCommitmentInvoice then refuses to raise a commitment behind it — so
  // `commitmentAmount` is 0 for a reason that has nothing to do with there
  // being nothing to pay. The plain zero-commitment copy told a customer with
  // an unpaid invoice already in their inbox that there was nothing to pay
  // right now and that we would send the final invoice nearer the time, days
  // before the move. /q gets this right (`showBalanceCard`); the email must
  // agree with it.
  const balanceMeta: DateConfirmationMeta = {
    ...zeroMeta,
    depositAmount: 500,
    balanceInvoiced: 1500,
    balanceInvoiceNumber: "INV-000243",
  };

  it("names the invoice that exists instead of promising one nearer the time", () => {
    const html = buildDateConfirmationEmailHtml(balanceMeta);
    const flat = html.toLowerCase();
    expect(html).toContain("£1,500");
    expect(html).toContain("INV-000243");
    expect(html).toContain("due before move day");
    expect(flat).not.toContain("nothing more to pay right now"); // preheader included
    expect(flat).not.toContain("final invoice nearer the time");
    expect(html).toContain("non-refundable"); // confirmation still flips the held position
    NO_PENALTY(html);
    NO_EM_DASH(html);
  });

  it("gives the outstanding ask a rail, not a figure with nowhere to send it", () => {
    const html = buildDateConfirmationEmailHtml(balanceMeta);
    expect(html).toContain(BANK_DETAILS.account);
    expect(html).toContain(BANK_DETAILS.sortCode);
    expect(html).toContain("MMR042"); // the transfer reference
  });

  it("a settled balance is reported settled, never asked for a second time", () => {
    const html = buildDateConfirmationEmailHtml({ ...balanceMeta, balanceSettled: true });
    const flat = html.toLowerCase();
    expect(html).toContain("settled in full");
    expect(html).toContain("nothing left to pay");
    expect(html).not.toContain(BANK_DETAILS.account);
    expect(flat).not.toContain("nothing more to pay right now");
    expect(flat).not.toContain("final invoice nearer the time");
    NO_PENALTY(html);
    NO_EM_DASH(html);
  });

  it("the template-var rail carries the same copy", () => {
    const vars = dateConfirmationTemplateVars(balanceMeta);
    expect(vars.COMMITMENT_BLOCK).toContain("£1,500");
    expect(vars.COMMITMENT_BLOCK).toContain("INV-000243");
    expect(vars.COMMITMENT_BLOCK.toLowerCase()).not.toContain("nothing more to pay right now");
    expect(vars.COMMITMENT_BLOCK.toLowerCase()).not.toContain("final invoice nearer the time");
    for (const v of Object.values(vars)) NO_PENALTY(v);
  });

  it("absent field keeps today's exact bytes for a booking with no balance invoice yet", () => {
    const zero = buildDateConfirmationEmailHtml(zeroMeta);
    expect(zero).toContain("nothing more to pay right now");
    expect(zero).toContain("we will send the final invoice nearer the time");
    expect(zero).not.toContain(BANK_DETAILS.account);
  });
});

describe("date-confirmation ack wording", () => {
  it("the signed ack carries the held/refunded position without penalty language", () => {
    for (const ack of DATE_CONFIRM_ACKS) {
      NO_PENALTY(ack.label);
    }
    const labels = DATE_CONFIRM_ACKS.map((a) => a.label).join(" ");
    expect(labels).toContain("non-refundable");
    expect(labels).toContain("refunded in full if the day is re-booked");
  });
});
