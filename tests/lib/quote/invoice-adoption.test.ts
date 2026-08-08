import { describe, expect, it } from "vitest";

import { adoptedInvoiceMatches } from "@/lib/quote/accept-flow";

/**
 * Orphan adoption exists for crash recovery — we created the invoice in Zoho,
 * died before writing the id back, and find it again next pass. The same
 * reference lookup also finds an invoice Connor raised BY HAND in Zoho, which
 * is a different thing entirely.
 */
describe("adoptedInvoiceMatches", () => {
  it("adopts an orphan that bills exactly what we computed", () => {
    expect(adoptedInvoiceMatches(750, 750)).toBe(true);
  });

  it("refuses one that bills a different figure", () => {
    // The scenario: panel computed £750, Connor raised £900 by hand. Adopting
    // records 750 while the customer holds a 900 PDF — whichever they pay, one
    // system is wrong, and syncZohoPayments would settle it off his number.
    expect(adoptedInvoiceMatches(900, 750)).toBe(false);
    expect(adoptedInvoiceMatches(700, 750)).toBe(false);
  });

  it("tolerates float noise but not a real penny difference", () => {
    expect(adoptedInvoiceMatches(750.0000001, 750)).toBe(true);
    expect(adoptedInvoiceMatches(750.01, 750)).toBe(false);
  });

  it("adopts when Zoho gave us no total — refusing would strand a real orphan", () => {
    // Older payloads omit it. A missing total is absence of evidence, and
    // blocking here would leave a genuine crash-recovery invoice unclaimed
    // forever with the claim marker stuck.
    expect(adoptedInvoiceMatches(undefined, 750)).toBe(true);
    expect(adoptedInvoiceMatches(Number.NaN, 750)).toBe(true);
  });
});
