import { describe, expect, it } from "vitest";
import { defaultQuoteValues } from "@/lib/quote/form-types";
import { computeQuote, DEFAULT_PRICING } from "@/lib/quote/pricing";
import { buildQuoteEmailHtml } from "@/lib/comms/quote-email";
import {
  BANK_DETAILS,
  buildBalanceInvoiceEmailHtml,
  buildBalanceReceivedEmailHtml,
  buildDepositReceivedEmailHtml,
} from "@/lib/comms/payment-email";

/** Customer-email content rules: accept CTA present when a URL exists, bank
 *  details + reference correct, amounts N2-derived, UK English, no em-dashes. */

const NO_EM_DASH = (html: string) => expect(html).not.toMatch(/—/);

function sampleQuote() {
  const values = defaultQuoteValues();
  values.customer = { name: "Jane Smith", phone: "07000000000", email: "jane@example.com" };
  values.job.moveDate = "2026-07-20";
  // Addresses set so the template renders real values, not "—" null placeholders
  // (the no-em-dash rule is about prose; empty-value glyphs would trip it).
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

describe("quote email", () => {
  const { values, b } = sampleQuote();
  const url = "https://ops.marleymoves.co.uk/q/abc123xyz";

  it("with an accept URL: the CTA is the accept page and steps say accept-online", () => {
    const html = buildQuoteEmailHtml(values, b, { quoteRef: "MM-T-1", acceptUrl: url, depositAmount: 100 });
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain("Accept your quote online");
    expect(html).toContain("£100 deposit");
    expect(html).toContain("Reply to confirm"); // mailto fallback stays available
    NO_EM_DASH(html);
  });

  it("without an accept URL: falls back to reply-to-confirm", () => {
    const html = buildQuoteEmailHtml(values, b, { quoteRef: "MM-T-1" });
    expect(html).not.toContain("/q/");
    expect(html).toContain("Reply to confirm this quote");
    NO_EM_DASH(html);
  });
});

describe("payment emails", () => {
  it("deposit received: amount, balance line, move date", () => {
    const html = buildDepositReceivedEmailHtml({
      firstName: "Jane Smith",
      quoteRef: "MM-T-1",
      amount: 100,
      moveDateLabel: "Monday 20 July",
      balanceAmount: 1340,
    });
    expect(html).toContain("£100");
    expect(html).toContain("£1,340");
    expect(html).toContain("Monday 20 July");
    expect(html).toContain("booked in");
    NO_EM_DASH(html);
  });

  it("balance invoice: amount, bank details with the QUOTE ref (not the -BAL ref), hosted link, NEVER card", () => {
    const html = buildBalanceInvoiceEmailHtml({
      firstName: "Jane",
      quoteRef: "MM-T-1",
      amount: 1340,
      moveDateLabel: "Monday 20 July",
      invoiceUrl: "https://zohoinvoicepay.eu/invoice/x",
      invoiceNumber: "INV-000200",
    });
    expect(html).toContain("£1,340");
    expect(html).toContain(BANK_DETAILS.sortCode);
    expect(html).toContain(BANK_DETAILS.account);
    expect(html).toContain(">MM-T-1<"); // BACS reference = quote ref, exact
    expect(html).toContain("INV-000200");
    expect(html).toContain("View your invoice");
    // The balance is BACS/cash only (card fees) — card copy must never appear,
    // Stripe or no Stripe.
    expect(html.toLowerCase()).not.toContain("card");
    NO_EM_DASH(html);
  });

  it("balance received: settled confirmation", () => {
    const html = buildBalanceReceivedEmailHtml({
      firstName: "Jane",
      quoteRef: "MM-T-1",
      amount: 1340,
      moveDateLabel: "Monday 20 July",
    });
    expect(html).toContain("£1,340");
    expect(html).toContain("nothing more to pay");
    NO_EM_DASH(html);
  });
});
