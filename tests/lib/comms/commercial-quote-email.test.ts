import { describe, expect, it } from "vitest";
import { buildQuoteEmailHtml, quoteEmailTemplateVars } from "@/lib/comms/quote-email";
import { computeQuote, DEFAULT_PRICING } from "@/lib/quote/pricing";
import { defaultQuoteValues } from "@/lib/quote/form-types";

/**
 * The quote email a COMMERCIAL customer receives (PRD §3.10, gate 10b).
 *
 * Sibling of tests/lib/pdf/commercial-quote-pdf.test.ts — the email carries the
 * PDF, so the same defect had to be fixed in both or the customer would open an
 * email saying one thing and an attachment saying another. This is the surface
 * they meet FIRST: it led with an "Accept your quote online" button and a
 * "£100 deposit" step for a booking that takes no deposit and whose accept page
 * refuses them (QA-20260828-03).
 *
 * The £100 is invented rather than stored. A commercial quote's deposit_amount
 * is 0, and `gbp(meta.depositAmount ?? 100)` only defends against null — 0 is
 * not null, so the step rendered "£0 deposit" once gate 10b started writing the
 * column honestly, and "£100 deposit" before that. Both are wrong; only one
 * looks obviously wrong.
 */

const b = computeQuote(
  {
    vehicle: "2luton",
    packing: "full",
    sevenFiveT: 0,
    transitVans: 0,
    days: 1,
    deadMiles: 10,
    jobMiles: 10,
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
const values = defaultQuoteValues();

const ACCEPT_URL = "https://ops.marleymoves.co.uk/q/tok_commercial_email";
/** A commercial quote as the office holds one: deposit_amount 0, and an accept
 *  token, because every quote gets one whatever its policy. */
const meta = { quoteRef: "MMC-260828-002", acceptUrl: ACCEPT_URL, depositAmount: 0 };

describe("commercial quote email", () => {
  it("residential is untouched — an explicit 'residential' is byte-identical to no policy at all", () => {
    const absent = buildQuoteEmailHtml(values, b, meta);
    expect(buildQuoteEmailHtml(values, b, { ...meta, paymentPolicy: "residential" })).toBe(absent);
    expect(buildQuoteEmailHtml(values, b, { ...meta, paymentPolicy: undefined })).toBe(absent);
  });

  it("the residential email DOES lead with accept-and-deposit — so the commercial scan is not vacuous", () => {
    const html = buildQuoteEmailHtml(values, b, { ...meta, depositAmount: 100 });
    expect(html.toLowerCase()).toContain("deposit");
    expect(html).toContain(ACCEPT_URL);
    expect(html).toContain("Accept your quote");
  });

  it("asks a commercial customer for NOTHING up front, and offers no way to accept online", () => {
    const html = buildQuoteEmailHtml(values, b, { ...meta, paymentPolicy: "commercial" });
    expect(html.toLowerCase(), "no deposit may be named anywhere in the email").not.toContain("deposit");
    expect(html, "the accept page must not be linked").not.toContain(ACCEPT_URL);
    expect(html, "no accept CTA, in the button or the steps").not.toContain("Accept your quote");
    expect(html, "the residential default must not surface as an amount").not.toContain("£100");
  });

  it("says what DOES happen — confirmation, then an invoice on the agreed terms", () => {
    const html = buildQuoteEmailHtml(values, b, { ...meta, paymentPolicy: "commercial" });
    // Removing the ask is half the job. A business customer's actual question
    // is when they get billed, so the steps must answer it rather than go
    // quiet — three steps, not two with a hole where the deposit was.
    expect(html).toContain("Our office will confirm this booking with you");
    expect(html).toContain("There is nothing to pay up front");
    expect(html).toContain("payable on your agreed terms");
    expect(html).toContain("Your invoice");
    // Still THREE steps: the numbered circles are part of the layout, so a
    // dropped rung would leave a numbered blank rather than reflow.
    expect(html).toContain(">1</div>");
    expect(html).toContain(">2</div>");
    expect(html).toContain(">3</div>");
  });

  it("never renders through the hosted Resend template, even with an accept URL present", () => {
    // The published template's slots are fixed (DEPOSIT_AMOUNT, ACCEPT_URL) and
    // create-resend-templates.mjs PATCHes hosted templates BY NAME, so editing
    // it for commercial would overwrite the live template every residential
    // customer receives (PRD §11.7 trap 4). Falling back to the in-repo body is
    // the deliberate trade: commercial loses dashboard-editable copy, Marley's
    // live email is never at risk.
    expect(quoteEmailTemplateVars(values, b, { ...meta, paymentPolicy: "commercial" })).toBeNull();
    // Residential still uses it — otherwise this test would pass against a
    // function that had simply stopped working.
    const residential = quoteEmailTemplateVars(values, b, meta);
    expect(residential).not.toBeNull();
    expect(residential!.ACCEPT_URL).toBe(ACCEPT_URL);
  });
});
