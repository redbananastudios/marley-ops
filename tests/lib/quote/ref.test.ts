import { describe, expect, it } from "vitest";
import { quoteRefKind } from "@/lib/quote/ref";
import { PROPERTY_SIZES } from "@/lib/leads/schema";

describe("quoteRefKind", () => {
  it("maps the office/commercial size to C", () => {
    expect(quoteRefKind("Office / commercial")).toBe("C");
  });

  it("matches office/commercial anywhere in the string, case-insensitively", () => {
    expect(quoteRefKind("Commercial")).toBe("C");
    expect(quoteRefKind("Small OFFICE move")).toBe("C");
    expect(quoteRefKind("commercial premises")).toBe("C");
  });

  it("maps every residential property size to R", () => {
    for (const size of PROPERTY_SIZES) {
      if (size === "Office / commercial") continue;
      expect(quoteRefKind(size)).toBe("R");
    }
  });

  it("defaults to R for null / undefined / blank", () => {
    expect(quoteRefKind(null)).toBe("R");
    expect(quoteRefKind(undefined)).toBe("R");
    expect(quoteRefKind("")).toBe("R");
    expect(quoteRefKind("   ")).toBe("R");
  });
});
