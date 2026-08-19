import { describe, expect, it } from "vitest";
import { defaultQuoteValues } from "@/lib/quote/form-types";
import { computeQuote, DEFAULT_PRICING } from "@/lib/quote/pricing";
import { buildQuoteEmailHtml } from "@/lib/comms/quote-email";
import {
  buildDepositReceivedEmailHtml,
  buildBalanceInvoiceEmailHtml,
  buildBalanceReceivedEmailHtml,
  buildReviewRequestEmailHtml,
} from "@/lib/comms/payment-email";
import { buildCompletionEmailHtml } from "@/lib/comms/completion-email";
import { buildStorageInvoiceEmailHtml } from "@/lib/comms/storage-invoice-email";
import { surveyConfirmEmailHtml } from "@/lib/comms/survey-email";

/**
 * B4 email rendering invariants (PRD Phase B) — checkable without a mail sink.
 * Every customer-facing email template, rendered with representative data, must
 * carry NO unresolved placeholders (no "undefined", "{{token}}", "NaN",
 * "[object Object]"), well-formed money (never £NaN/£undefined; the app's prose
 * style is whole-£ like £1,700, pence only when non-zero), no leaked ISO
 * timestamp, and the right recipient's name. The full "open it in
 * Gmail/Outlook/Apple Mail" pass stays a human step; this catches the class of
 * bug that ships a broken template.
 */

const PLACEHOLDERS = [/undefined/i, /\bNaN\b/, /\{\{|\}\}/, /\[object Object\]/];

function assertB4Clean(html: string, label: string) {
  expect(html.length, `${label}: empty`).toBeGreaterThan(50);
  for (const re of PLACEHOLDERS) expect(html, `${label}: contains ${re}`).not.toMatch(re);
  // Malformed money: a £ immediately followed by a non-number / bad token.
  expect(html.match(/£\s*(?:NaN|undefined|null|[.,)])/gi), `${label}: malformed £ amount`).toBeNull();
  // No raw ISO timestamp leaking into customer copy.
  expect(html, `${label}: leaked ISO datetime`).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
}

function sampleQuote() {
  const values = defaultQuoteValues();
  values.customer = { name: "Jane Smith", phone: "07000000000", email: "jane@example.com" };
  values.job.moveDate = "2026-07-20";
  values.job.collectAddr = "1 High Street, Shaftesbury, SP7 8AA";
  values.job.destAddr = "2 Mill Lane, Gillingham, SP8 4BB";
  const b = computeQuote(
    {
      vehicle: "1luton",
      packing: "owner",
      deadMiles: null,
      jobMiles: null,
      collectAccessM: 0,
      destAccessM: 0,
      collectType: "house",
      collectFloor: "ground",
      destType: "house",
      destFloor: "ground",
      congestion: false,
      tolls: 0,
      parking: 0,
      discount: 0,
      vatEnabled: true,
    },
    DEFAULT_PRICING,
  );
  return { values, b };
}

describe("B4 — customer email templates render clean", () => {
  it("quote email", () => {
    const { values, b } = sampleQuote();
    const html = buildQuoteEmailHtml(values, b, {
      quoteRef: "MM-260720-001",
      acceptUrl: "https://ops.marleymoves.co.uk/q/abc123xyz",
      depositAmount: 100,
    });
    assertB4Clean(html, "quote");
    expect(html).toContain("Jane");
    expect(html).toContain("MM-260720-001");
    expect(html).toMatch(/£\d{1,3}(,\d{3})*(\.\d{2})?/); // a properly formatted total
  });

  it("deposit received", () => {
    const html = buildDepositReceivedEmailHtml({
      firstName: "Jane Smith",
      quoteRef: "MM-260720-001",
      amount: 100,
      moveDateLabel: "Monday 20 July",
      balanceAmount: 1700,
    });
    assertB4Clean(html, "deposit-received");
    expect(html).toContain("Jane");
    expect(html).toContain("£1,700"); // balance shown with a thousands separator
  });

  it("balance invoice (never card copy)", () => {
    const html = buildBalanceInvoiceEmailHtml({
      firstName: "Jane",
      quoteRef: "MM-260720-001",
      amount: 1700,
      moveDateLabel: "Monday 20 July",
      invoiceUrl: "https://invoice.zoho.eu/x",
      invoiceNumber: "INV-000123",
    });
    assertB4Clean(html, "balance-invoice");
    expect(html).toContain("£1,700");
    expect(html).toContain("https://invoice.zoho.eu/x");
    expect(html.toLowerCase()).not.toContain("pay by card"); // BACS/cash only at these values
  });

  it("balance received", () => {
    const html = buildBalanceReceivedEmailHtml({ firstName: "Jane", quoteRef: "MM-260720-001", amount: 1700, moveDateLabel: "Monday 20 July" });
    assertB4Clean(html, "balance-received");
    expect(html).toContain("£1,700");
  });

  it("review request", () => {
    const html = buildReviewRequestEmailHtml({ firstName: "Jane", reviewUrl: "https://g.page/r/xyz" });
    assertB4Clean(html, "review-request");
    expect(html).toContain("https://g.page/r/xyz");
    expect(html).toContain("Jane");
    expect(html).toContain("Leave a Google review"); // platform defaults to Google
  });

  it("review request names the platform the link goes to", () => {
    const html = buildReviewRequestEmailHtml({
      firstName: "Jane",
      reviewUrl: "https://uk.trustpilot.com/evaluate/marleymoves.co.uk",
      platform: "Trustpilot",
    });
    assertB4Clean(html, "review-request-trustpilot");
    expect(html).toContain("Leave a Trustpilot review");
    expect(html).not.toContain("Google review"); // copy must not claim Google while the button goes to Trustpilot
  });

  it("completion certificate email", () => {
    const html = buildCompletionEmailHtml({
      firstName: "Jane",
      moveDateLabel: "Friday, 10 July 2026",
      hasExceptions: false,
      exceptions: "",
      customerAbsent: false,
    });
    assertB4Clean(html, "completion");
    expect(html).toContain("Jane");
    expect(html).toContain("Friday, 10 July 2026");
  });

  it("storage invoice email", () => {
    const html = buildStorageInvoiceEmailHtml({
      firstName: "Jane",
      unitLabel: "20ft container SC-1 at Shaftesbury Yard",
      periodLabel: "14 Jul – 20 Jul 2026",
      amountLabel: "£25.00",
      invoiceNumber: "INV-000124",
      invoiceUrl: "https://invoice.zoho.eu/y",
    });
    assertB4Clean(html, "storage-invoice");
    expect(html).toContain("£25.00");
    expect(html).toContain("20ft container SC-1");
  });

  it("survey confirmation email", () => {
    const html = surveyConfirmEmailHtml({
      customerName: "Jane Smith",
      dateLabel: "Thursday 10 July",
      timeLabel: "14:00",
      estimatorName: "Luke",
      address: "1 High Street, Shaftesbury",
    });
    assertB4Clean(html, "survey-confirm");
    expect(html).toContain("Thursday 10 July");
    expect(html).toContain("14:00");
  });

  it("catches a deliberately broken render (guards the guard)", () => {
    // A NaN amount must be caught by assertB4Clean, proving the check has teeth.
    const broken = buildDepositReceivedEmailHtml({ firstName: "Jane", quoteRef: "X", amount: Number("oops") });
    expect(() => assertB4Clean(broken, "broken")).toThrow();
  });
});
