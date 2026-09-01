import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { storageInvoiceNote } from "@/lib/storage/raise-storage-invoices";

/**
 * The customer-visible "how to pay" note on a STORAGE ledger invoice.
 *
 * It was a module-level constant, keyed by invoice kind, with one office
 * number and one card offer baked into all four strings — so every brand's
 * storage customer was handed the default brand's phone number and offered a
 * payment channel their brand may not have. Two independent facts were
 * conflated into a literal: which brand this let belongs to, and whether card
 * is live at all.
 *
 * These tests pin them apart, the same way `card-toggle.test.ts` does for the
 * removals invoice note. The default brand's strings are asserted as LITERALS
 * lifted verbatim from the constant this seam replaces — a test that compared
 * the note to a brands row would pass just as happily against a row somebody
 * had edited, and this is a document a real customer is holding.
 */

const DEFAULT_PAY = { phone: "01747 637070", cardPhone: true };

describe("storageInvoiceNote — byte-exact for the default brand", () => {
  it("reproduces today's in-advance period wording exactly", () => {
    expect(storageInvoiceNote("period", DEFAULT_PAY)).toBe(
      "Storage is billed in advance per period. Pay by bank transfer using the invoice number as " +
        "the reference, or by card over the phone on 01747 637070.",
    );
  });

  it("reproduces today's minimum-period wording exactly", () => {
    expect(storageInvoiceNote("minimum", DEFAULT_PAY)).toBe(
      "Your minimum storage period, billed in advance; further days are charged to the exact day " +
        "in arrears. Pay by bank transfer using the invoice number as the reference, or by card " +
        "over the phone on 01747 637070.",
    );
  });

  it("reproduces today's arrears wording exactly", () => {
    expect(storageInvoiceNote("arrears", DEFAULT_PAY)).toBe(
      "Storage days billed in arrears to the exact day. Pay by bank transfer using the invoice " +
        "number as the reference, or by card over the phone on 01747 637070.",
    );
  });

  it("reproduces today's final-invoice wording exactly", () => {
    expect(storageInvoiceNote("final", DEFAULT_PAY)).toBe(
      "Final storage invoice. All charges are settled before items are released. Pay by bank " +
        "transfer using the invoice number as the reference, or by card over the phone on " +
        "01747 637070.",
    );
  });
});

describe("storageInvoiceNote — the phone number follows the brand", () => {
  const OTHER = { phone: "01258 858564", cardPhone: true };

  it("quotes the paying brand's own number, never the default brand's", () => {
    for (const kind of ["period", "minimum", "arrears", "final"] as const) {
      const note = storageInvoiceNote(kind, OTHER);
      expect(note).toContain("01258 858564");
      // That number reaches a different office. A customer who rings it gets
      // someone who has never heard of them.
      expect(note, `${kind} leaked the default number`).not.toContain("01747 637070");
    }
  });
});

describe("storageInvoiceNote — card is named only where card is live", () => {
  /**
   * The launch posture for a bank-transfer-only brand. Both switches are the
   * caller's job to AND together (the global kill switch lives in
   * business_settings and this pure function cannot see it); what is pinned
   * here is that a false answer removes the word entirely rather than
   * softening it.
   */
  it("names no card channel at all when card is off", () => {
    for (const kind of ["period", "minimum", "arrears", "final"] as const) {
      const note = storageInvoiceNote(kind, { phone: "01258 858564", cardPhone: false });
      expect(note, `${kind} still mentions card`).not.toMatch(/card/i);
    }
  });

  it("keeps bank transfer as the instruction, not as a fallback", () => {
    const note = storageInvoiceNote("period", { phone: "01258 858564", cardPhone: false });
    expect(note).toContain("Pay by bank transfer using the invoice number as the reference");
    // A number to ring still belongs on an invoice — it is a support line, not
    // a payment rail, so it survives the card channel being off.
    expect(note).toContain("01258 858564");
  });

  it("changes when the switch changes — the control is not inert", () => {
    const on = storageInvoiceNote("final", { phone: "01258 858564", cardPhone: true });
    const off = storageInvoiceNote("final", { phone: "01258 858564", cardPhone: false });
    expect(on).not.toBe(off);
  });

  it("keeps the kind-specific opening line whichever way the switch falls", () => {
    for (const cardPhone of [true, false]) {
      expect(storageInvoiceNote("final", { phone: "01258 858564", cardPhone })).toContain(
        "Final storage invoice. All charges are settled before items are released.",
      );
      expect(storageInvoiceNote("arrears", { phone: "01258 858564", cardPhone })).toContain(
        "Storage days billed in arrears to the exact day.",
      );
    }
  });
});

/**
 * The pure function above can be correct and the invoice still wrong, because
 * the defect was never in the wording — it was that the wording never reached
 * a brand at all. These assert the CALL SITE actually resolves one, which no
 * unit test of a pure function can show.
 */
describe("the storage billing run resolves a brand before it writes a note", () => {
  const src = readFileSync(join(process.cwd(), "lib/storage/raise-storage-invoices.ts"), "utf8");

  it("hardcodes no phone number", () => {
    expect(src).not.toContain("01747");
    expect(src).not.toContain("01258");
  });

  it("asks for BOTH card switches, not just the brand's", () => {
    // `cardPaymentsAvailable` ANDs the gateway credentials, the global kill
    // switch and the brand row. Reading the brand flag alone here would offer
    // a card channel while the kill switch was down.
    expect(src).toContain("cardPaymentsAvailable(");
    expect(src, "the note must not gate on the brand flag alone").not.toContain(
      "brand.cardPaymentsEnabled",
    );
  });

  it("takes the brand from the LET being billed, not from a default", () => {
    // Derived from the let row itself...
    expect(src).toMatch(/const letBrand = \(let_ as/);
    // ...and that same value reaches both the card verdict and the note's
    // brand. A note resolved against any other brand is the original defect
    // wearing a function call.
    expect(src).toContain("cardPaymentsAvailable(admin, letBrand)");
    // brandForComms wraps getBrandOrDefault and overlays the LIVE card verdict
    // (global kill switch AND brand toggle) — the comms-canonical resolver the
    // card-toggle tripwire requires. The let's own brand still drives it.
    expect(src).toContain('brandForComms(admin, letBrand ?? "marley")');
  });

  it("gives the emailed half of the invoice the same brand and card verdict", () => {
    // The email and the ledger note describe one invoice. Resolving the brand
    // twice from the same column is how the two halves come to disagree.
    expect(src).toMatch(/letBrand,\s*\}\);/);
    expect(src).toContain("offerCardPhone: await cardPaymentsAvailable(");
  });

  it("no longer carries a module-level note constant", () => {
    // The shape of the original defect: four strings, fixed at module load,
    // with no brand in scope to resolve them against.
    expect(src).not.toMatch(/const NOTES\b/);
  });
});
