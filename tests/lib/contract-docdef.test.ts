import { describe, expect, it } from "vitest";
import { buildContractDocDef, termsToContent, type ContractDocData } from "@/lib/contract-docdef";
import { currentVersion, versionById } from "@/lib/legal/documents";
import type { DocBrand } from "@/lib/pdf/doc-brand";

const base: ContractDocData = {
  documentTitle: "Contract",
  quoteRef: "MMR039",
  customerName: "Pamela Noble",
  moveDate: "2026-08-26",
  from: "1 High Street, SP7 9PX",
  to: "2 Low Road, BH1 4DQ",
  priceLabel: "£1,680.00",
  signerName: "Pamela Noble",
  signatureImage: null,
  method: "typed",
  channel: "remote",
  signedAtLabel: "11:22 on Monday, 10 August 2026",
  collectedByName: null,
  ip: "81.2.3.4",
  acknowledgments: [
    { label: "The move details and inventory in my quote are complete and correct.", ticked: true },
    { label: "I understand items in boxes I pack myself are not covered for breakage.", ticked: false },
  ],
  termsTitle: "Terms & Conditions",
  termsVersionId: "customer-terms-v1-2026-06-16",
  termsSha256: "a".repeat(64),
  termsBody: versionById("customer-terms-v1-2026-06-16")!.body,
  legalReviewPending: true,
};

const flat = (d: ContractDocData) => JSON.stringify(buildContractDocDef(d));

describe("contract doc-def", () => {
  it("names a vfs font — an unset font makes pdfmake hang forever", () => {
    // The trap that has bitten this codebase before (lessons-learned).
    expect(buildContractDocDef(base).defaultStyle.font).toBe("Montserrat");
  });

  it("carries the whole evidence pack, not just the signature", () => {
    const s = flat(base);
    for (const expected of [
      "Pamela Noble",
      "MMR039",
      "customer-terms-v1-2026-06-16",
      "81.2.3.4",
      "11:22 on Monday, 10 August 2026",
      "typed signature",
      "SHA-256",
    ]) {
      expect(s, expected).toContain(expected);
    }
  });

  it("contains the actual terms text, which is what makes it a contract", () => {
    // Without the terms in the document it is a receipt for an agreement, not
    // the agreement. This clause is v1-specific, so it also proves the PDF
    // renders the version SIGNED rather than the version current today.
    expect(flat(base)).toContain("fully refundable if you cancel more than 48 hours");
    expect(flat(base)).not.toContain("25% of your total price");
  });

  it("shows an unticked acknowledgment as untickeed, never silently as agreed", () => {
    const s = flat(base);
    expect(s).toContain("NOT TICKED");
    expect(s).toContain("YES");
  });

  it("renders a typed name in the script face when there is no drawn image", () => {
    const typed = buildContractDocDef(base);
    expect(JSON.stringify(typed)).toContain("Cormorant");
    const drawn = flat({ ...base, signatureImage: "data:image/png;base64,AAAA", method: "drawn" });
    expect(drawn).toContain("data:image/png;base64,AAAA");
    expect(drawn).toContain("drawn signature");
  });

  it("says so when the terms have not been through a solicitor", () => {
    expect(flat(base)).toContain("not yet been reviewed by a solicitor");
    expect(flat({ ...base, legalReviewPending: false })).not.toContain("not yet been reviewed");
  });

  it("names an in-person collector, so the crew-tablet path is auditable", () => {
    const s = flat({ ...base, channel: "in_person", collectedByName: "Connor" });
    expect(s).toContain("in person on a Marley Moves device");
    expect(s).toContain("collected by Connor");
  });

  it("no brand renders today's default-brand literals — the byte-parity contract", () => {
    const s = flat(base);
    expect(s).toContain("MARLEY MOVES");
    expect(s).toContain("#C03838");
    expect(s).not.toContain("Pitmans");
  });

  it("a brand substitutes its identity, group disclosure, legal line, colour and device line", () => {
    const pitmans: DocBrand = {
      slug: "pitmans",
      name: "Pitmans Removals & Storage",
      shortName: "Pitmans",
      groupLine: "Part of the Marley Group",
      legalLine: "MarleyMoves Ltd trading as Pitmans Removals & Storage · Company No. 15914266",
      phone: "01258 000000",
      email: "info@example.co.uk",
      websiteUrl: null,
      colour: "#2B2B76",
    };
    // A neutral terms body: the real published terms name the default brand,
    // which would mask a leak assertion.
    const s = flat({
      ...base,
      quoteRef: "PMR001",
      channel: "in_person",
      termsBody: "## 1. Scope\n\nThe Company will carry out the removal.",
      brand: pitmans,
    });
    expect(s).toContain("PITMANS REMOVALS & STORAGE");
    expect(s).toContain("Part of the Marley Group");
    expect(s).toContain("MarleyMoves Ltd trading as Pitmans Removals & Storage · Company No. 15914266");
    expect(s).toContain("in person on a Pitmans device");
    expect(s).toContain("#2B2B76");
    // No default-brand leak: no red, no wordmark, no default device line.
    expect(s).not.toContain("#C03838");
    expect(s).not.toContain("MARLEY MOVES");
    expect(s).not.toContain("Marley Moves device");
  });

  it("survives the fields a real row can be missing", () => {
    expect(() =>
      buildContractDocDef({
        ...base,
        quoteRef: null,
        moveDate: null,
        from: "",
        to: "",
        priceLabel: null,
        ip: null,
        acknowledgments: [],
      }),
    ).not.toThrow();
  });
});

describe("termsToContent", () => {
  it("turns headings, bullets and bold into pdfmake nodes", () => {
    const out = termsToContent("## 2. Quotes\n\n- Valid for **30 days**.\n\nPlain paragraph.");
    expect(out[0]).toMatchObject({ text: "2. Quotes", style: "termsHead" });
    expect(JSON.stringify(out[1])).toContain("30 days");
    expect(JSON.stringify(out)).toContain("Plain paragraph");
  });

  it("drops nothing from a real published document", () => {
    // Every non-empty line must survive into the PDF. A markdown subset that
    // silently swallowed a clause would be worse than no PDF at all.
    const body = currentVersion("customer-terms").body;
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(termsToContent(body)).toHaveLength(lines.length);
  });
});
