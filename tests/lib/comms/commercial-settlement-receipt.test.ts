import { describe, expect, it } from "vitest";
import {
  balanceReceivedTemplateVars,
  buildBalanceReceivedEmailHtml,
} from "@/lib/comms/payment-email";
import { pitmans } from "./brand-fixture";

/**
 * The settlement RECEIPT a commercial client receives (PRD §3.10).
 *
 * The completion invoice email got its own commercial arm (the sibling test,
 * commercial-completion-invoice.test.ts); the receipt confirming its payment
 * did not. `markBalancePaid` had no policy branch anywhere in its receipt
 * path, so a business's accounts department settling a completion invoice —
 * for a move that finished BEFORE the invoice was raised — was told "We will
 * see you on move day", promised "You're all set for move day" in the
 * preheader, warned which livery might attend a day already gone, and, when
 * the hosted residential template is published, received that template's
 * fixed residential copy verbatim.
 *
 * Residential parity is the strongest invariant in this file and is asserted
 * first, not assumed.
 */

const NO_EM_DASH = (html: string) => expect(html).not.toMatch(/—/);

/** A residential settlement exactly as it is sent today. */
const residential = {
  firstName: "Jane Smith",
  quoteRef: "MMR042",
  amount: 1500,
  moveDateLabel: "Thursday 20 August",
  receipt: {
    receiptNumber: "MMR042-BAL",
    paidAtLabel: "18 August 2026",
    method: "bank_transfer" as const,
    forLabel: "Final balance",
    amount: 1500,
  },
};

/** The same settlement on the commercial ladder: a completion invoice paid. */
const commercial = {
  ...residential,
  quoteRef: "MMC-260828-002",
  paymentPolicy: "commercial" as const,
  invoiceNumber: "INV-000200",
  receipt: {
    ...residential.receipt,
    receiptNumber: "MMC-260828-002-BAL",
    forLabel: "Completion invoice",
  },
};

describe("residential settlement receipt is byte-identical", () => {
  it("an explicit 'residential' and a missing policy render the same bytes", () => {
    const original = buildBalanceReceivedEmailHtml(residential);
    expect(buildBalanceReceivedEmailHtml({ ...residential, paymentPolicy: "residential" })).toBe(
      original,
    );
    expect(buildBalanceReceivedEmailHtml({ ...residential, paymentPolicy: null })).toBe(original);
    expect(buildBalanceReceivedEmailHtml({ ...residential, paymentPolicy: undefined })).toBe(
      original,
    );
    // An invoice number is meaningless on the residential arm, and a stray one
    // must never change a single byte of what a residential customer reads.
    expect(buildBalanceReceivedEmailHtml({ ...residential, invoiceNumber: "INV-000200" })).toBe(
      original,
    );
  });

  it("residential still promises move day, which is exactly right there", () => {
    // Without this the commercial assertions below would pass just as well
    // against a receipt that had stopped promising move day for everyone.
    const html = buildBalanceReceivedEmailHtml(residential);
    expect(html).toContain("We will see you on");
    expect(html).toContain("all set for move day");
    expect(html).toContain("Final balance");
  });

  it("residential still carries the pre-move attendance disclosure off-brand", () => {
    const html = buildBalanceReceivedEmailHtml({ ...residential, brand: pitmans });
    expect(html).toContain("may attend on the day");
  });

  it("residential template vars are unchanged and still returned", () => {
    const vars = balanceReceivedTemplateVars(residential);
    expect(vars).not.toBeNull();
    expect(vars!.QUOTE_REF).toBe("MMR042");
    expect(vars!.AMOUNT).toBe("£1,500");
    expect(vars!.MOVE_DAY_LABEL).toBe("Thursday 20 August");
  });
});

describe("commercial settlement receipt", () => {
  it("never promises move day to a client whose move already happened", () => {
    // The defect, stated as its own test. On the commercial ladder the job
    // finished before the invoice was raised, so every move-day claim in this
    // email is about a day already gone.
    const html = buildBalanceReceivedEmailHtml(commercial);
    expect(html).not.toContain("move day");
    expect(html).not.toContain("We will see you");
  });

  it("keeps the promise out of the preheader too, not only the body", () => {
    // The preheader is the line a client reads in the inbox list before
    // opening anything.
    const html = buildBalanceReceivedEmailHtml(commercial);
    const preheader = html.slice(0, html.indexOf("<body") + 2000);
    expect(preheader).not.toContain("move day");
    expect(preheader).toContain("settled");
  });

  it("says what a settlement receipt must: paid, which invoice, all settled, thanks", () => {
    const html = buildBalanceReceivedEmailHtml(commercial);
    expect(html).toContain("All settled");
    expect(html).toContain("£1,500");
    expect(html).toContain("INV-000200");
    expect(html).toContain("nothing more to pay");
    expect(html).toContain("Thank you for your business");
  });

  it("still carries the formal receipt panel", () => {
    // The email doubles as the customer's receipt (Peter, 2026-08-04) under
    // either policy. Dropping the wrong sentences must not drop the receipt.
    const html = buildBalanceReceivedEmailHtml(commercial);
    expect(html).toContain("Receipt no.");
    expect(html).toContain("MMC-260828-002-BAL");
    expect(html).toContain("18 August 2026");
    expect(html).toContain("Bank transfer");
  });

  it("never carries the pre-move attendance disclosure", () => {
    // The disclosure prepares a customer for the livery that turns up "on the
    // day", and this receipt is sent after that day has passed — same call the
    // completion invoice email already made.
    const html = buildBalanceReceivedEmailHtml({ ...commercial, brand: pitmans });
    expect(html).not.toContain("may attend");
  });

  it("never names a deposit or a commitment a commercial client did not pay", () => {
    const html = buildBalanceReceivedEmailHtml(commercial);
    expect(html.toLowerCase()).not.toContain("deposit");
    expect(html.toLowerCase()).not.toContain("commitment");
  });

  it("never uses the word 'penalty'", () => {
    // Hard copy rule, docs/payments-policy-v2-prd.md — inherited by any new
    // payment email, including this one.
    for (const html of [
      buildBalanceReceivedEmailHtml(commercial),
      buildBalanceReceivedEmailHtml({ ...commercial, invoiceNumber: null }),
    ]) {
      expect(html.toLowerCase()).not.toContain("penalt");
    }
  });

  it("renders clean UK English with no unresolved placeholders", () => {
    for (const html of [
      buildBalanceReceivedEmailHtml(commercial),
      buildBalanceReceivedEmailHtml({ ...commercial, invoiceNumber: null }),
      buildBalanceReceivedEmailHtml({ ...commercial, receipt: null }),
      buildBalanceReceivedEmailHtml({ ...commercial, firstName: null }),
    ]) {
      NO_EM_DASH(html);
      expect(html).not.toMatch(/undefined/i);
      expect(html).not.toMatch(/\bNaN\b/);
      expect(html).not.toMatch(/\{\{|\}\}/);
      expect(html).not.toContain("[object Object]");
    }
  });

  it("never renders through the hosted Resend template", () => {
    // Same trade as the completion invoice email. The published receipt
    // template is a separately hand-written copy whose fixed slots promise
    // move day, and create-resend-templates.mjs PATCHes hosted templates BY
    // NAME — so editing it for commercial would overwrite the live template
    // every residential customer receives (PRD §11.7 trap 4). Returning null
    // costs a commercial client the dashboard-editable copy and nothing else.
    expect(balanceReceivedTemplateVars(commercial)).toBeNull();
    expect(balanceReceivedTemplateVars({ ...commercial, invoiceNumber: null })).toBeNull();
  });
});
