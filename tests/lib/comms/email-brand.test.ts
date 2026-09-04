/**
 * Multi-brand email theme (gate 13, PRD §3.5) — the headline property and the
 * Pitmans rendering rules.
 *
 * The SHA-256 locks below were computed from the PRE-CHANGE builder
 * implementations (git HEAD at gate-13 start), after a temp matrix test
 * proved every brand-threaded builder byte-equal to its pre-change original
 * with brand absent. If one of these fails, a Marley customer email changed
 * bytes — that is a finding, not a snapshot to refresh casually.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { emailTheme, themedBankCard, themedButtonRow, themedEmailShell, themedPill, themedDarkFooter, BANK_DETAILS } from "@/lib/comms/email-brand";
import { buildBalanceInvoiceEmailHtml, buildDepositReceivedEmailHtml } from "@/lib/comms/payment-email";
import type { Brand } from "@/lib/brand";
import { pitmans } from "./brand-fixture";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const receipt = {
  receiptNumber: "MMR019-DEP",
  paidAtLabel: "4 August 2026",
  method: "bank_transfer" as const,
  forLabel: "Booking deposit",
  amount: 100,
};


describe("emailTheme — the headline property", () => {
  it("marley/absent/null all yield the identical literal theme", () => {
    const t = emailTheme();
    expect(emailTheme(null)).toBe(t);
    // cardPaymentsEnabled: true matches MARLEY_THEME's implicit card-on state
    // — this proves every OTHER field never leaks from the row, not that the
    // row is ignored outright (see the card-flag test below for that half,
    // 869ett5wy).
    const marleyRow = { ...pitmans, slug: "marley", name: "EDITED", cardPaymentsEnabled: true } as Brand;
    // The default theme's STRINGS never depend on the brands row round-tripping.
    expect(emailTheme(marleyRow)).toBe(t);
    expect(t.name).toBe("Marley Moves");
    expect(t.phone).toBe("01747 637070");
    expect(t.accent).toBe("#C03838");
    expect(t.pillBg).toBe("#FFF3F1");
    expect(t.pillBorder).toBe("#F5C9C4");
    expect(t.callHtml).toBe('call Connor on <strong style="color:#C03838;">01747 637070</strong>');
    expect(t.payToNoteHtml("MMR001")).toBe("");
    expect(t.attendNoteHtml).toBe("");
    expect(t.groupLine).toBe("");
  });

  /**
   * 869ett5wy: the ONE field allowed to vary for the default brand is the card
   * mention, driven by `cardPaymentsEnabled` on the resolved brand (the
   * EFFECTIVE flag when a caller went through `brandForComms` — see
   * `card-toggle.test.ts` for the end-to-end wiring proof). Everything else
   * about "EDITED"/pitmans-shaped row content still never leaks.
   */
  it("marley's card mention follows the row's cardPaymentsEnabled — nothing else does", () => {
    const marleyRowCardOff = { ...pitmans, slug: "marley", name: "EDITED" } as Brand; // pitmans fixture: cardPaymentsEnabled false
    const off = emailTheme(marleyRowCardOff);
    expect(off.cardPhone).toBe(false);
    expect(off.payMethodsText).not.toMatch(/card/i);
    expect(off.payMethodsLine).not.toMatch(/card/i);
    // Every other field is still the untouched Marley literal.
    expect(off.name).toBe("Marley Moves");
    expect(off.phone).toBe("01747 637070");
    expect(off.accent).toBe("#C03838");
    expect(off.callHtml).toBe('call Connor on <strong style="color:#C03838;">01747 637070</strong>');
  });

  it("marley renders are byte-locked to the pre-change implementation", () => {
    expect(
      sha(buildDepositReceivedEmailHtml({ firstName: "Brydee", quoteRef: "MMR034", amount: 100, moveDateLabel: "Monday 20 July", balanceAmount: 750.5, receipt })),
    ).toBe("b104276355969c3c988641ab510c7ec135626765829e0cc0aeab117d670eb72f");
    expect(
      sha(buildBalanceInvoiceEmailHtml({ firstName: "Greig", quoteRef: "MMR042", amount: 1234.56, moveDateLabel: "Friday 14 August", invoiceUrl: "https://inv.example/x", invoiceNumber: "MMR042-BAL" })),
    ).toBe("d7d417d65fa1cda8f0856367fd7c000ba41c9ab90eaee612a76884c11956ce3f");
  });
});

describe("emailTheme — non-default brand", () => {
  const t = emailTheme(pitmans);

  it("derives identity, colours and contact from the row", () => {
    expect(t.isDefault).toBe(false);
    expect(t.name).toBe("Pitmans Removals & Storage");
    // Yellow fails the white-text WCAG rule, so the interactive accent is the
    // primary blue (same data rule as brandCtaColour — no slug switches).
    expect(t.accent).toBe("#2B2B76");
    expect(t.phone).toBe("01258 858564");
    expect(t.telHref).toBe("tel:01258858564");
    expect(t.helloAddress).toBe("info@pitmansremovals.co.uk");
    expect(t.websiteLabel).toBe("pitmansremovals.co.uk");
    expect(t.callHtml).toContain("call us on");
    expect(t.callHtml).toContain("01258 858564");
    expect(t.callHtml).not.toContain("Connor");
    // No logo yet → wordmark in the primary colour.
    expect(t.logoHtml).toContain("Pitmans Removals &amp; Storage");
    expect(t.logoHtml).toContain("#2B2B76");
  });

  it("card copy is gated on the brand's phone-card channel", () => {
    expect(t.cardPhone).toBe(false);
    expect(t.payMethodsLine).toBe("Bank transfer or cash. Whichever suits.");
    expect(emailTheme(pitmans, { cardPhone: true }).payMethodsLine).toContain("card over the phone on 01258 858564");
  });

  it("disclosure (a) names MarleyMoves Ltd, the account and the reference, inside the bank card", () => {
    const card = themedBankCard("PMR034", t);
    expect(card).toContain(BANK_DETAILS.name);
    expect(card).toContain("part of MarleyMoves Ltd");
    expect(card).toContain("PMR034");
    // Marley's card carries no such note — its bytes are today's.
    expect(themedBankCard("MMR034")).not.toContain("part of MarleyMoves Ltd");
  });

  it("disclosure (b) names the Marley Moves vehicle/crew possibility", () => {
    expect(t.attendNoteHtml).toContain("a Marley Moves vehicle or crew may attend");
    expect(t.attendNoteText).toContain("a Marley Moves vehicle or crew may attend");
  });

  it("the shell carries the brand identity, group line and legal line — no Marley chrome", () => {
    const html = themedEmailShell("preheader", "", t);
    expect(html).toContain("Part of the Marley Group");
    expect(html).toContain("trading name of MarleyMoves Ltd");
    expect(html).toContain("tel:01258858564");
    expect(html).toContain("https://pitmansremovals.co.uk");
    // No Marley contact surface leaks (the LEGAL entity MarleyMoves Ltd is
    // required copy and deliberately present).
    expect(html).not.toContain("01747 637070");
    expect(html).not.toContain("marleymoves.co.uk/logo.png");
    expect(html).not.toContain(">Marley <");
    expect(html).not.toContain("Shaftesbury, SP7");
  });

  it("the dark footer carries brand contact + group line", () => {
    const html = themedDarkFooter(t);
    expect(html).toContain("Pitmans Removals &amp; Storage");
    expect(html).toContain("Part of the Marley Group");
    expect(html).toContain("info@pitmansremovals.co.uk");
    expect(html).not.toContain("01747 637070");
    expect(html).not.toContain("#E85959");
  });

  it("pill and buttons take the brand accent", () => {
    expect(themedPill("Ref PMR001", t)).toContain("#2B2B76");
    expect(themedPill("Ref PMR001", t)).not.toContain("#C03838");
    const btn = themedButtonRow("https://x.example", "View your invoice &rarr;", t);
    expect(btn).toContain('bgcolor="#2B2B76"');
    expect(btn).not.toContain("#C03838");
  });

  it("customer copy renders the brand end to end (deposit received)", () => {
    const html = buildDepositReceivedEmailHtml({
      firstName: "Mark",
      quoteRef: "PMR001",
      amount: 100,
      moveDateLabel: "Monday 5 October",
      receipt: { ...receipt, receiptNumber: "PMR001-DEP" },
      brand: pitmans,
    });
    expect(html).toContain("Pitmans Removals &amp; Storage");
    expect(html).toContain("a Marley Moves vehicle or crew may attend");
    expect(html).toContain("01258 858564");
    expect(html).not.toContain("01747 637070");
    expect(html).not.toContain("Connor");
  });

  it("balance invoice carries both disclosures and no card copy", () => {
    const html = buildBalanceInvoiceEmailHtml({
      firstName: "Mark",
      quoteRef: "PMR001",
      amount: 900,
      moveDateLabel: "Monday 5 October",
      brand: pitmans,
    });
    expect(html).toContain("part of MarleyMoves Ltd");
    expect(html).toContain(BANK_DETAILS.account);
    expect(html).toContain("a Marley Moves vehicle or crew may attend");
    expect(html).toContain("Bank transfer or cash. Whichever suits.");
    expect(html).not.toContain("card over the phone");
  });
});

describe("themedDarkFooter - the legal identity on a document the customer keeps", () => {
  it("the default brand's footer is byte-locked to today's literal", () => {
    const html = themedDarkFooter();
    expect(html).toContain("Marley Moves \u00b7 Company No. 15914266 \u00b7 01747 637070");
    // The light-footer meta line must not leak into the dark footer.
    expect(html).not.toContain("Shaftesbury, SP7");
  });

  it("another brand carries its own legal line, not a bare company number", () => {
    const html = themedDarkFooter(emailTheme(pitmans));
    expect(html).toContain("Part of the Marley Group");
    // The whole point: the operating company is NAMED as the operating company
    // and the VAT number is present. This footer goes on a storage invoice, the
    // one document a customer keeps for a VAT-bearing charge (QA-20260826-04).
    expect(html).toContain("trading name of MarleyMoves Ltd");
    expect(html).toContain("VAT 520 2213 58");
    // The defect shape: the brand's own name followed straight by someone
    // else's registration, reading as though it were the brand's own.
    expect(html).not.toMatch(/Storage \u00b7 Company No\./);
    // ...and no default-brand contact details anywhere on it.
    expect(html).not.toContain("01747 637070");
  });
});
