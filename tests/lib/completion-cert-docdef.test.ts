import { describe, expect, it } from "vitest";
import { buildCompletionCertDocDef, type CompletionCertData } from "@/lib/completion-cert-docdef";
import type { DocBrand } from "@/lib/pdf/doc-brand";

const base: CompletionCertData = {
  quoteRef: "MMR051",
  customerName: "Jane Doe",
  moveDate: "2026-08-26",
  from: "1 High Street, SP8 4GH",
  to: "2 Low Road, BH1 4DQ",
  crewName: "Rob Pierce",
  crewSignature: "data:image/png;base64,AAAA",
  customerSignature: "data:image/png;base64,BBBB",
  customerAbsent: false,
  absentReason: "",
  exceptions: "",
  signedAtLabel: "16:42 on Friday, 10 July 2026",
};

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

const flat = (d: CompletionCertData) => JSON.stringify(buildCompletionCertDocDef(d));

describe("completion cert brand rendering (multi-brand PRD §3.6 — a JOB document)", () => {
  it("no brand renders today's default-brand literals — the byte-parity contract", () => {
    const s = flat(base);
    expect(s).toContain("MARLEY ");
    expect(s).toContain("completed by Marley Moves");
    expect(s).toContain("CREW LEAD — MARLEY MOVES");
    expect(s).toContain("Marley Moves Ltd · Company No. 15914266 · 01747 637070 · hello@marleymoves.co.uk");
    expect(s).toContain("#C03838");
    expect(s).not.toContain("Pitmans");
  });

  it("a brand substitutes its row-sourced identity, group disclosure, legal line and colour", () => {
    const s = flat({ ...base, quoteRef: "PMR001", brand: pitmans });
    expect(s).toContain("PITMANS REMOVALS & STORAGE");
    expect(s).toContain("Part of the Marley Group");
    expect(s).toContain("completed by Pitmans Removals & Storage");
    expect(s).toContain("CREW LEAD — PITMANS REMOVALS & STORAGE");
    expect(s).toContain("MarleyMoves Ltd trading as Pitmans Removals & Storage · Company No. 15914266 · 01258 000000 · info@example.co.uk");
    expect(s).toContain("#2B2B76");
    // No default-brand leak: no red, no Marley wordmark or contact identity.
    expect(s).not.toContain("#C03838");
    expect(s).not.toContain("MARLEY ");
    expect(s).not.toContain("Marley Moves");
    expect(s).not.toContain("01747 637070");
  });

  it("does not embed a review ask or URL for any brand — the review rule lives in comms, not the cert", () => {
    for (const s of [flat(base), flat({ ...base, brand: pitmans })]) {
      expect(s.toLowerCase()).not.toContain("review");
      expect(s).not.toContain("g.page");
      expect(s).not.toContain("http");
    }
  });
});
