import { describe, expect, it } from "vitest";
import { computeQuote, DEFAULT_PRICING } from "@/lib/quote/pricing";
import { defaultQuoteValues } from "@/lib/quote/form-types";
import { buildQuoteDocDef, quotePdfFilename } from "@/lib/quote/pdf-client";
import { docBrandFrom, type DocBrand } from "@/lib/pdf/doc-brand";
import { mapBrand } from "@/lib/brand";

/**
 * The PDF is a VAT document — its visible line items MUST sum exactly to the
 * subtotal, and every money figure must be N2 (0.00). These tests walk the real
 * pdfmake doc-def so a future line-item omission (like the silently-rolled-in
 * admin fee this fixes) fails CI instead of reaching a customer.
 */

const GBP = /^£[\d,]+\.\d{2}$/;
const parseGbp = (s: string): number => Number(s.replace(/[£,]/g, ""));

/** Kitchen-sink inputs — every charge type switched on, fractional mileage. */
function kitchenSink() {
  const pricing = { ...DEFAULT_PRICING, extraDayRate: 400 };
  const b = computeQuote(
    {
      vehicle: "2luton",
      packing: "full",
      sevenFiveT: 2,
      transitVans: 1,
      days: 3,
      deadMiles: 9.7,
      jobMiles: 9.7, // 19.4 mi × £2 = £38.80 → rounds to £39
      collectAccessM: 15,
      destAccessM: 25,
      collectType: "flat",
      collectFloor: "2nd",
      destType: "flat",
      destFloor: "1st",
      congestion: true,
      tolls: 12.34,
      parking: 5,
      discount: 100,
      vatEnabled: true,
    },
    pricing,
  );
  const values = defaultQuoteValues();
  values.job.days = 3;
  values.route = { deadMiles: 9.7, jobMiles: 9.7, routeLegs: [] };
  return { values, b };
}

/** The breakdown table is the only content entry with the 5 line-item columns. */
type PdfCell = { text: string };
type PdfTableEntry = { table?: { widths?: unknown[]; headerRows?: number; body?: PdfCell[][] } };
function lineItemRows(docDef: unknown): PdfCell[][] {
  const content = (docDef as { content: PdfTableEntry[] }).content;
  const tbl = content.find((c) => c?.table?.widths?.length === 5 && c.table.headerRows === 1);
  expect(tbl).toBeTruthy();
  return tbl!.table!.body!.slice(1); // drop the header row
}

describe("quote PDF doc-def — money correctness", () => {
  const { values, b } = kitchenSink();
  const docDef = buildQuoteDocDef(values, b, {
    quoteRef: "MM-TEST-001",
    vatNumber: "GB 123 4567 89",
    depositAmount: 100,
    acceptUrl: "https://ops.marleymoves.co.uk/q/abc123",
  });
  const flat = JSON.stringify(docDef);

  it("line items sum EXACTLY to the subtotal (admin fee inside 'Your Removal', nothing hidden)", () => {
    const rows = lineItemRows(docDef);
    const sum = rows.reduce((acc, row) => acc + parseGbp(row[4].text), 0);
    expect(sum).toBeCloseTo(b.subtotal, 2);
    // Customer-facing grouping: the admin fee is folded into "Your Removal", it is
    // NOT a separate customer line anymore.
    expect(flat).toContain("Your Removal");
    expect(flat).not.toContain("Administration Fee");
  });

  it("subtotal − discount + VAT = quote total, all shown", () => {
    expect(flat).toContain(JSON.stringify("VAT (20%)").slice(1, -1));
    expect(flat).not.toContain("Tax (");
    expect(b.grandTotal).toBeCloseTo((b.subtotal - b.discount) * 1.2, 10);
  });

  it("every amount is N2 (0.00) format", () => {
    const rows = lineItemRows(docDef);
    for (const row of rows) {
      expect(row[3].text).toMatch(GBP); // unit price
      expect(row[4].text).toMatch(GBP); // amount
    }
    // spot the headline figures too
    const two = (n: number) => "£" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(flat).toContain(two(b.subtotal));
    expect(flat).toContain(two(b.grandTotal));
  });

  it("red total bar reads TOTAL INCLUDING VAT with the N2 grand total", () => {
    const bar = flat.indexOf("TOTAL INCLUDING VAT");
    expect(bar).toBeGreaterThan(-1);
    const two = "£" + b.grandTotal.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(flat.slice(bar, bar + 400)).toContain(two);
  });

  it("footer carries the VAT number when set, and an explicit dash when blank", () => {
    const withVat = JSON.stringify(docDef.footer(1, 2));
    expect(withVat).toContain("VAT No. GB 123 4567 89");
    expect(withVat).toContain("Company No. 15914266");
    expect(withVat).toContain("Page 1 of 2");

    const noVat = buildQuoteDocDef(values, b, { quoteRef: "MM-TEST-002" });
    expect(JSON.stringify(noVat.footer(1, 2))).toContain("VAT No. —");
  });

  it("acceptance strip + terms page carry the deposit, QR slots and accept URL", () => {
    expect(flat).toContain("£100 deposit");
    expect(flat).toContain("A booking deposit of £100");
    expect(flat).toContain("Accept online: https://ops.marleymoves.co.uk/q/abc123");
    // two QR slots — page 1 strip + page 2 acceptance box
    const qrCount = (flat.match(/"qr":/g) ?? []).length;
    expect(qrCount).toBe(2);
    expect(flat).toContain("Quote Assumptions & Terms");
    expect(flat).toContain("CUSTOMER ACCEPTANCE");
    expect(flat).toContain("BANK DETAILS");
    expect(flat).toContain("hello@marleymoves.co.uk");
  });

  it("without an accept URL: no QR nodes, written-acceptance wording, deposit defaults to £100", () => {
    const plain = buildQuoteDocDef(values, b, { quoteRef: "MM-TEST-004" });
    const s = JSON.stringify(plain);
    expect((s.match(/"qr":/g) ?? []).length).toBe(0);
    expect(s).toContain("reply in writing and pay the £100 deposit");
  });

  it("VAT off renders VAT (0%) — the row is never hidden", () => {
    const offB = computeQuote({
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
      vatEnabled: false,
    });
    const off = JSON.stringify(buildQuoteDocDef(defaultQuoteValues(), offB, { quoteRef: "MM-TEST-003" }));
    expect(off).toContain("VAT (0%)");
  });
});

/**
 * Brand layer (docs/multi-brand-prd.md §3.6): a quote PDF carries its job's
 * brand. THE headline property — no brand renders exactly today's Marley
 * document; a non-default brand substitutes its brands-row values with no
 * slug switches, so these tests drive a Pitmans-shaped plain object.
 */
describe("quote PDF doc-def — brand layer (PRD §3.6)", () => {
  const { values, b } = kitchenSink();
  const meta = {
    quoteRef: "PMR001",
    vatNumber: "520 2213 58",
    depositAmount: 100,
    acceptUrl: "https://ops.marleymoves.co.uk/q/abc123",
  };
  // Built through the real resolver from a seed-shaped brands row, so these
  // tests also pin docBrandFrom's contract (WCAG colour pick, default → null).
  const pitmans = docBrandFrom(
    mapBrand({
      slug: "pitmans",
      name: "Pitmans Removals & Storage",
      short_name: "Pitmans",
      group_line: "Part of the Marley Group",
      legal_line:
        "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd. Company No. 15914266. VAT 520 2213 58.",
      phone: "01258 858564",
      website_url: "https://pitmansremovals.co.uk",
      hello_from: "info@pitmansremovals.co.uk",
      colour_primary: "#2B2B76",
      colour_accent: "#FFCC00",
    }),
  ) as DocBrand;
  const branded = buildQuoteDocDef(values, b, { ...meta, brand: pitmans });
  const flat = JSON.stringify(branded);

  it("docBrandFrom: default brand resolves to null; Pitmans arrives as data", () => {
    expect(docBrandFrom(mapBrand({ slug: "marley", name: "Marley Moves", short_name: "Marley" }))).toBeNull();
    expect(pitmans).not.toBeNull();
    expect(pitmans.shortName).toBe("Pitmans");
  });

  it("no brand (undefined or null) renders the identical Marley doc-def", () => {
    const plain = JSON.stringify(buildQuoteDocDef(values, b, meta));
    expect(JSON.stringify(buildQuoteDocDef(values, b, { ...meta, brand: undefined }))).toBe(plain);
    expect(JSON.stringify(buildQuoteDocDef(values, b, { ...meta, brand: null }))).toBe(plain);
    // and the Marley literals are pinned: red accent, contact rows, title
    expect(plain).toContain("#C03838");
    expect(plain).toContain("01747 637070");
    expect(plain).toContain("hello@marleymoves.co.uk");
    expect(plain).toContain("www.marleymoves.co.uk");
    expect(JSON.stringify(buildQuoteDocDef(values, b, meta).info)).toContain("MarleyMoves Quote PMR001");
  });

  it("a non-default brand carries no Marley identity leaks", () => {
    // Red accent fully replaced (badge SVGs + text colours; the soft-tint fills
    // live in layout functions, which JSON.stringify drops — not assertable here).
    expect(flat).not.toContain("#C03838");
    expect(flat).not.toContain("01747 637070");
    expect(flat).not.toContain("hello@marleymoves.co.uk");
    expect(flat).not.toContain("www.marleymoves.co.uk");
    expect(flat).not.toContain("MarleyMoves Quote");
    // no logo image node anywhere — the brand identity renders as a text wordmark
    expect(flat).not.toContain('"image"');
  });

  it("WCAG data rule: white text fails on the yellow accent, so blue primary is the accent", () => {
    expect(pitmans.colour).toBe("#2B2B76");
    expect(flat).toContain("#2B2B76");
    expect(flat).not.toContain("#FFCC00");
  });

  it("brand identity block: wordmark + the group-line disclosure, on both pages", () => {
    const marks = flat.match(/Pitmans Removals & Storage/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(2); // page 1 + page 2 wordmarks
    const group = flat.match(/Part of the Marley Group/g) ?? [];
    expect(group.length).toBeGreaterThanOrEqual(2);
  });

  it("brand contact rows: phone, contact mailbox, website (protocol stripped)", () => {
    expect(flat).toContain("01258 858564");
    expect(flat).toContain("info@pitmansremovals.co.uk");
    expect(flat).toContain('"pitmansremovals.co.uk"');
  });

  it("footer renders the brand legal line, VAT stated exactly once per page", () => {
    const footer = JSON.stringify(branded.footer(1, 2));
    expect(footer).toContain("is a trading name of MarleyMoves Ltd");
    expect(footer).toContain("Ref: PMR001");
    expect(footer).toContain("Page 1 of 2");
    // the legal line already carries VAT 520 2213 58 — no duplicate "VAT No." segment
    expect((footer.match(/520 2213 58/g) ?? []).length).toBe(1);
    expect(footer).not.toContain("VAT No.");
  });

  it("footer adds the VAT No. segment when the legal line does not carry it", () => {
    const noVatInLegal = buildQuoteDocDef(values, b, {
      ...meta,
      brand: { ...pitmans, legalLine: "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd. Company No. 15914266." },
    });
    expect(JSON.stringify(noVatInLegal.footer(1, 2))).toContain("VAT No. 520 2213 58");
  });

  it("filename: brand short name prefixes; Marley keeps today's exact shape", () => {
    expect(quotePdfFilename("PMR001", pitmans)).toBe("Pitmans-Quote-PMR001.pdf");
    expect(quotePdfFilename("MM-TEST-001")).toBe("MarleyMoves-Quote-MM-TEST-001.pdf");
    expect(quotePdfFilename("MM-TEST-001", null)).toBe("MarleyMoves-Quote-MM-TEST-001.pdf");
  });

  it("bank details stay MarleyMoves for every brand — one shared account (PRD §2)", () => {
    expect(flat).toContain("MARLEYMOVES LTD");
    expect(flat).toContain("04-00-03");
  });

  it("the VAT-document invariant holds on a branded doc: items sum to the subtotal", () => {
    const rows = lineItemRows(branded);
    const sum = rows.reduce((acc, row) => acc + parseGbp(row[4].text), 0);
    expect(sum).toBeCloseTo(b.subtotal, 2);
  });

  it("a brand row with no usable colours keeps the Marley red palette, brand text intact", () => {
    const colourless = JSON.stringify(
      buildQuoteDocDef(values, b, { ...meta, brand: { ...pitmans, colour: "#C03838" } }),
    );
    expect(colourless).toContain("#C03838");
    expect(colourless).toContain("Pitmans Removals & Storage");
    expect(colourless).not.toContain("hello@marleymoves.co.uk");
  });
});
