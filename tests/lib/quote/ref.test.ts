import { describe, expect, it } from "vitest";
import { looksCommercial, quoteRefKind } from "@/lib/quote/ref";
import { PROPERTY_SIZES } from "@/lib/leads/schema";

/**
 * Gate 8 changed quoteRefKind's SOURCE (the client's type now leads) without
 * changing any reference it issues. The first block below is the whole of the
 * pre-gate-8 suite re-run with the residential policy every live client
 * resolves to — it passes unchanged, which is the evidence that this gate is
 * inert for live references.
 */
describe("quoteRefKind — unchanged for every client we actually have", () => {
  it("still maps the office/commercial size to C", () => {
    expect(quoteRefKind("residential", "Office / commercial")).toBe("C");
  });

  it("still matches office/commercial anywhere in the string, case-insensitively", () => {
    expect(quoteRefKind("residential", "Commercial")).toBe("C");
    expect(quoteRefKind("residential", "Small OFFICE move")).toBe("C");
    expect(quoteRefKind("residential", "commercial premises")).toBe("C");
  });

  it("still maps every residential property size to R", () => {
    for (const size of PROPERTY_SIZES) {
      if (size === "Office / commercial") continue;
      expect(quoteRefKind("residential", size)).toBe("R");
    }
  });

  it("still defaults to R for null / undefined / blank", () => {
    expect(quoteRefKind("residential", null)).toBe("R");
    expect(quoteRefKind("residential", undefined)).toBe("R");
    expect(quoteRefKind("residential", "")).toBe("R");
    expect(quoteRefKind("residential", "   ")).toBe("R");
  });
});

describe("quoteRefKind — the client's type leads", () => {
  it("issues C for a commercial client whatever the property size says", () => {
    expect(quoteRefKind("commercial", "3 bedroom")).toBe("C");
    expect(quoteRefKind("commercial", null)).toBe("C");
    expect(quoteRefKind("commercial", "Studio / 1 bedroom")).toBe("C");
  });

  it("keeps the property-size hint as a FALLBACK, never as an override", () => {
    // The direction that matters: a commercial client is never demoted to R by
    // a residential-looking property size. Dropping the fallback the other way
    // would have cost the two live "Office / commercial" enquiries their C
    // prefix, since no production client carries is_company (2026-08-28).
    expect(quoteRefKind("commercial", "2 bedroom")).toBe("C");
    expect(quoteRefKind("residential", "Office / commercial")).toBe("C");
  });
});

describe("looksCommercial", () => {
  it("recognises the one property size that has ever matched in production", () => {
    expect(looksCommercial("Office / commercial")).toBe(true);
  });

  it("is false for every residential size and for nothing at all", () => {
    for (const size of PROPERTY_SIZES) {
      if (size === "Office / commercial") continue;
      expect(looksCommercial(size)).toBe(false);
    }
    expect(looksCommercial(null)).toBe(false);
    expect(looksCommercial(undefined)).toBe(false);
    expect(looksCommercial("")).toBe(false);
  });
});
