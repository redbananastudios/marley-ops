import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invoicePdfFilename } from "@/lib/quote/pdf-client";

/**
 * Invoice attachment filenames follow the same brand-shortName shape as the
 * quote PDF (PRD §3.6 / §10: Pitmans-Quote-PMR001.pdf): the default brand
 * keeps today's exact MarleyMoves bytes, any other brand prefixes its own
 * shortName. Until now the commitment and balance invoice emails hardcoded
 * `MarleyMoves-Invoice-*.pdf` for every brand — a Pitmans customer's VAT
 * invoice arrived under the other company's name.
 */
describe("invoicePdfFilename", () => {
  it("default brand (null DocBrand) keeps today's exact Marley shape", () => {
    expect(invoicePdfFilename("INV-000203", null)).toBe("MarleyMoves-Invoice-INV-000203.pdf");
    expect(invoicePdfFilename("commitment")).toBe("MarleyMoves-Invoice-commitment.pdf");
  });

  it("a non-default brand prefixes its short name", () => {
    expect(invoicePdfFilename("INV-000203", { shortName: "Pitmans" })).toBe(
      "Pitmans-Invoice-INV-000203.pdf",
    );
  });

  it("a brand row with a blank short name degrades to the default shape, never a bare dash", () => {
    expect(invoicePdfFilename("INV-1", { shortName: "" })).toBe("MarleyMoves-Invoice-INV-1.pdf");
  });
});

describe("accept-flow attaches brand-resolved invoice filenames", () => {
  // Source guard (house convention for these deep-IO surfaces): both invoice
  // emails — date-confirmation/commitment and balance — must resolve the
  // attachment name through the shared helper rather than a literal.
  const FLOW = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");

  it("no hardcoded MarleyMoves-Invoice literal remains", () => {
    expect(FLOW).not.toContain("MarleyMoves-Invoice-");
  });

  it("both invoice emails resolve the filename through the shared helper", () => {
    const calls = FLOW.match(/invoicePdfFilename\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
