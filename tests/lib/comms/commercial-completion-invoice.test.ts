import { describe, expect, it } from "vitest";
import {
  balanceInvoiceTemplateVars,
  buildBalanceInvoiceEmailHtml,
  BANK_DETAILS,
} from "@/lib/comms/payment-email";

/**
 * The COMPLETION invoice email a commercial client receives (PRD §3.10).
 *
 * The commercial completion invoice deliberately reuses the BALANCE columns,
 * the `-BAL` reference suffix and this very template, because it is the last
 * invoice on a job under either policy. That reuse is correct. What was not
 * correct is that the template still spoke residential: every commercial client
 * was told "Payment in full is due before move day" about an invoice raised
 * BY HAND after the move, payable on 30 or 60 day terms.
 *
 * It reached them unconditionally. Commercial takes no deposit, so
 * `depositOutstanding` is always 0 and the copy always took the branch that
 * makes the claim — there was no arm of this template that did not assert a
 * deadline that had already passed. The invoice NOTES had been fixed for this
 * (`Payable on your agreed terms, by <date>`); the email carrying that invoice
 * had not, so the PDF and the message wrapping it disagreed.
 *
 * The vocabulary here is not invented. It is the wording the commercial quote
 * email, the commercial quote PDF, `/q`'s commercial review screen and the
 * invoice notes already use: "payable on your agreed terms".
 *
 * Residential parity is the strongest invariant in this file and is asserted
 * first, not assumed.
 */

const NO_EM_DASH = (html: string) => expect(html).not.toMatch(/—/);

/** A residential balance exactly as it is sent today. */
const base = {
  firstName: "Jane Smith",
  quoteRef: "MMR042",
  amount: 1500,
  moveDateLabel: "Thursday 20 August",
  invoiceUrl: "https://inv.example/x",
  invoiceNumber: "INV-000200",
};

/** The same job on the commercial ladder: no deposit, terms date stamped. */
const commercial = {
  ...base,
  quoteRef: "MMC-260828-002",
  paymentPolicy: "commercial" as const,
  termsDueDateLabel: "Monday 29 September",
};

describe("residential balance copy is byte-identical", () => {
  it("an explicit 'residential' and a missing policy render the same bytes", () => {
    // The parity assertion for every balance invoice ever sent. A terms label
    // must be inert on the residential arm too: it is meaningless there, and a
    // stray one must never change a single byte of what a residential customer
    // reads.
    const original = buildBalanceInvoiceEmailHtml(base);
    expect(buildBalanceInvoiceEmailHtml({ ...base, paymentPolicy: "residential" })).toBe(original);
    expect(buildBalanceInvoiceEmailHtml({ ...base, paymentPolicy: null })).toBe(original);
    expect(buildBalanceInvoiceEmailHtml({ ...base, paymentPolicy: undefined })).toBe(original);
    expect(
      buildBalanceInvoiceEmailHtml({ ...base, termsDueDateLabel: "Monday 29 September" }),
    ).toBe(original);
  });

  it("residential parity holds with a deposit still outstanding too", () => {
    // The gate 9b arm. Two policies times two deposit states is four
    // renderings, and only the commercial pair may differ from today.
    const original = buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 500 });
    expect(
      buildBalanceInvoiceEmailHtml({ ...base, depositOutstanding: 500, paymentPolicy: "residential" }),
    ).toBe(original);
  });

  it("residential still says the balance is due before move day", () => {
    // Without this the commercial assertions below would pass just as well
    // against a template that had stopped making the claim for everyone.
    const html = buildBalanceInvoiceEmailHtml(base);
    expect(html).toContain("due before move day");
    expect(html).toContain("Final balance");
    expect(html).toContain("deposit is already accounted for");
  });

  it("residential template vars are unchanged and still returned", () => {
    const vars = balanceInvoiceTemplateVars(base);
    expect(vars).not.toBeNull();
    expect(vars!.QUOTE_REF).toBe("MMR042");
    expect(vars!.AMOUNT).toBe("£1,500");
  });
});

describe("commercial completion invoice email", () => {
  it("never tells a commercial client their money was due before move day", () => {
    // The defect, stated as its own test. Commercial has no deposit, so this
    // is what EVERY commercial client received.
    const html = buildBalanceInvoiceEmailHtml(commercial);
    expect(html).not.toContain("due before move day");
    expect(html).not.toContain("Payment in full is due");
    // And with the date absent, where a template that simply dropped the
    // sentence in one arm would still leak it from the other.
    const noDate = buildBalanceInvoiceEmailHtml({ ...commercial, termsDueDateLabel: null });
    expect(noDate).not.toContain("due before move day");
    expect(noDate).not.toContain("Payment in full is due");
  });

  it("says the invoice follows the completed job and falls due on the agreed terms", () => {
    const html = buildBalanceInvoiceEmailHtml(commercial);
    expect(html).toContain("is complete");
    expect(html).toContain("payable on your agreed terms");
    expect(html).toContain("Monday 29 September");
  });

  it("states the terms rather than a date when no terms date exists", () => {
    // The house rule this codebase has been bitten by four times: a missing
    // value must not render as the reassuring answer. There is no day to name,
    // so it names none — and it does not go silent about the terms either.
    const html = buildBalanceInvoiceEmailHtml({ ...commercial, termsDueDateLabel: null });
    expect(html).toContain("payable on your agreed terms");
    expect(html).not.toContain("Monday 29 September");
    // No half-built sentence left behind by the missing label — a dangling
    // "payable on your agreed terms, by ." is worse than either answer.
    expect(html).not.toContain("terms, by");
    expect(html).not.toContain("terms by");
    expect(html).not.toMatch(/\bby\s*(<\/strong>|[.,])/);
  });

  it("never names a deposit or a commitment a commercial client did not pay", () => {
    const html = buildBalanceInvoiceEmailHtml(commercial);
    expect(html.toLowerCase()).not.toContain("deposit");
    expect(html.toLowerCase()).not.toContain("commitment");
  });

  it("never uses the word 'penalty'", () => {
    // Hard copy rule, docs/payments-policy-v2-prd.md — terms, /q, emails, UI.
    // Inherited by any new payment email, including this one.
    for (const html of [
      buildBalanceInvoiceEmailHtml(commercial),
      buildBalanceInvoiceEmailHtml({ ...commercial, termsDueDateLabel: null }),
    ]) {
      expect(html.toLowerCase()).not.toContain("penalt");
    }
  });

  it("still carries the figure, the invoice and the bank rail", () => {
    // The email must remain a working invoice: what is owed, which document it
    // is, where to view it and how to pay. Deleting a wrong sentence is only
    // half the job.
    const html = buildBalanceInvoiceEmailHtml(commercial);
    expect(html).toContain("£1,500");
    expect(html).toContain("INV-000200");
    expect(html).toContain("View your invoice");
    expect(html).toContain(BANK_DETAILS.account);
    expect(html).toContain(">MMC-260828-002<");
  });

  it("keeps the commercial rail card-free, exactly as the residential one is", () => {
    // The completion invoice is raised with online payments disabled, so a
    // card button here would be a dead end (Peter, 2026-07-09).
    const html = buildBalanceInvoiceEmailHtml(commercial);
    expect(html.toLowerCase()).not.toContain("pay by card");
  });

  it("carries the claim in the preheader too, not only in the body", () => {
    // The preheader is the line a client reads in the inbox list before
    // opening anything, so a corrected body under a stale preheader still
    // delivers the wrong message.
    const html = buildBalanceInvoiceEmailHtml(commercial);
    const preheader = html.slice(0, html.indexOf("<body") + 2000);
    expect(preheader).not.toContain("due before move day");
    expect(preheader).toContain("agreed terms");
  });

  it("renders clean UK English with no unresolved placeholders", () => {
    for (const html of [
      buildBalanceInvoiceEmailHtml(commercial),
      buildBalanceInvoiceEmailHtml({ ...commercial, termsDueDateLabel: null }),
      buildBalanceInvoiceEmailHtml({ ...commercial, invoiceUrl: null, invoiceNumber: null }),
    ]) {
      NO_EM_DASH(html);
      expect(html).not.toMatch(/undefined/i);
      expect(html).not.toMatch(/\bNaN\b/);
      expect(html).not.toMatch(/\{\{|\}\}/);
      expect(html).not.toContain("[object Object]");
    }
  });

  it("never renders through the hosted Resend template", () => {
    // Same trade as the commercial quote email. The published template is a
    // separately hand-written copy whose fixed slots assert "due before move
    // day", and create-resend-templates.mjs PATCHes hosted templates BY NAME —
    // so editing it for commercial would overwrite the live template every
    // residential customer receives (PRD §11.7 trap 4). Returning null costs a
    // commercial client the dashboard-editable copy and nothing else.
    expect(balanceInvoiceTemplateVars(commercial)).toBeNull();
    expect(balanceInvoiceTemplateVars({ ...commercial, termsDueDateLabel: null })).toBeNull();
  });
});
