import { describe, expect, it } from "vitest";
import {
  formatPersonName,
  formatPersonNameOrNull,
  formatUkPostcode,
  formatUkPostcodeOrNull,
} from "@/lib/leads/format";

describe("formatPersonName", () => {
  // The three real examples Peter reported (2026-08-14).
  it("title-cases lowercase surnames", () => {
    expect(formatPersonName("Paul betty")).toBe("Paul Betty");
    expect(formatPersonName("Jai coombes")).toBe("Jai Coombes");
    expect(formatPersonName("Annabel sutton")).toBe("Annabel Sutton");
  });

  it("title-cases an all-lowercase name", () => {
    expect(formatPersonName("paul betty")).toBe("Paul Betty");
  });

  it("normalises a fully SHOUTED name", () => {
    expect(formatPersonName("JAI COOMBES")).toBe("Jai Coombes");
  });

  it("keeps a caps word inside a mixed name (initials)", () => {
    expect(formatPersonName("PJ Harvey")).toBe("PJ Harvey");
    expect(formatPersonName("PJ harvey")).toBe("PJ Harvey");
  });

  it("keeps deliberately mixed-case words as typed", () => {
    expect(formatPersonName("Sarah McDonald")).toBe("Sarah McDonald");
    expect(formatPersonName("Dave van der Berg")).toBe("Dave Van Der Berg");
  });

  it("handles hyphens, apostrophes and the Mc prefix", () => {
    expect(formatPersonName("anne-marie o'brien")).toBe("Anne-Marie O'Brien");
    expect(formatPersonName("liam mcdonald")).toBe("Liam McDonald");
    // "Mac" stays plain title-case — Macey is not MacEy.
    expect(formatPersonName("jim macey")).toBe("Jim Macey");
  });

  it("collapses whitespace", () => {
    expect(formatPersonName("  jai   coombes ")).toBe("Jai Coombes");
  });

  it("null wrapper returns null for empty", () => {
    expect(formatPersonNameOrNull(null)).toBeNull();
    expect(formatPersonNameOrNull("  ")).toBeNull();
    expect(formatPersonNameOrNull("paul betty")).toBe("Paul Betty");
  });
});

describe("formatUkPostcode", () => {
  it("uppercases and inserts the inward-code space", () => {
    expect(formatUkPostcode("bh218nb")).toBe("BH21 8NB");
    expect(formatUkPostcode("sp7 8pl")).toBe("SP7 8PL");
    expect(formatUkPostcode("SP84UP")).toBe("SP8 4UP");
    expect(formatUkPostcode(" so41 0ue ")).toBe("SO41 0UE");
  });

  it("collapses doubled spaces and odd separators", () => {
    expect(formatUkPostcode("BH21  8NB")).toBe("BH21 8NB");
    expect(formatUkPostcode("bh21-8nb")).toBe("BH21 8NB");
  });

  it("handles the London two-part outward shape", () => {
    expect(formatUkPostcode("sw1a1aa")).toBe("SW1A 1AA");
  });

  it("uppercases an outward-only partial without a space", () => {
    expect(formatUkPostcode("sp7")).toBe("SP7");
    expect(formatUkPostcode("dt10")).toBe("DT10");
  });

  it("leaves non-postcode text untouched (never mangle free text)", () => {
    expect(formatUkPostcode("Yeovil")).toBe("Yeovil");
    expect(formatUkPostcode("TBC with customer")).toBe("TBC with customer");
  });

  it("null wrapper returns null for empty", () => {
    expect(formatUkPostcodeOrNull(null)).toBeNull();
    expect(formatUkPostcodeOrNull("")).toBeNull();
    expect(formatUkPostcodeOrNull("bh218nb")).toBe("BH21 8NB");
  });
});
