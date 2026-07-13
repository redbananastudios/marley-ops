import { describe, expect, it } from "vitest";
import { computeQuote, DEFAULT_PRICING } from "@/lib/quote/pricing";
import { defaultQuoteValues } from "@/lib/quote/form-types";
import { buildQuoteDocDef } from "@/lib/quote/pdf-client";

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

  it("line items sum EXACTLY to the subtotal (admin fee itemised, nothing rolled in)", () => {
    const rows = lineItemRows(docDef);
    const sum = rows.reduce((acc, row) => acc + parseGbp(row[4].text), 0);
    expect(sum).toBeCloseTo(b.subtotal, 2);
    expect(flat).toContain("Administration Fee");
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
