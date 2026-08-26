import { describe, expect, it } from "vitest";
import { docBrandFrom, tintTowardsWhite } from "@/lib/pdf/doc-brand";
import { mapBrand } from "@/lib/brand";

const row = (over: Record<string, unknown> = {}) =>
  mapBrand({
    slug: "pitmans",
    name: "Pitmans Removals & Storage",
    short_name: "Pitmans",
    initial: "P",
    group_line: "Part of the Marley Group",
    legal_line: "MarleyMoves Ltd trading as Pitmans Removals & Storage · Company No. 15914266",
    colour_primary: "#2B2B76",
    colour_accent: "#FFCC00",
    phone: "01258 000000",
    hello_from: "info@example.co.uk",
    ...over,
  });

describe("docBrandFrom", () => {
  it("resolves the DEFAULT brand to null — the doc-defs' own constants ARE that rendering", () => {
    expect(docBrandFrom(mapBrand({ slug: "marley", name: "Marley Moves", short_name: "Marley" }))).toBeNull();
  });

  it("maps a second brand's identity fields through as plain data", () => {
    expect(docBrandFrom(row())).toMatchObject({
      slug: "pitmans",
      name: "Pitmans Removals & Storage",
      shortName: "Pitmans",
      groupLine: "Part of the Marley Group",
      legalLine: "MarleyMoves Ltd trading as Pitmans Removals & Storage · Company No. 15914266",
      phone: "01258 000000",
      email: "info@example.co.uk",
    });
  });

  it("WCAG data rule: a light accent (yellow, for large flat areas) never becomes the heading colour", () => {
    // White text fails 3:1 on #FFCC00, so the primary wins — blue headings.
    expect(docBrandFrom(row())!.colour).toBe("#2B2B76");
  });

  it("takes the accent when white text IS legible on it", () => {
    expect(docBrandFrom(row({ colour_accent: "#7A1F1F" }))!.colour).toBe("#7A1F1F");
  });

  it("degrades to the existing red when the row carries no usable colour — never a blank", () => {
    expect(docBrandFrom(row({ colour_primary: null, colour_accent: null }))!.colour).toBe("#C03838");
  });
});

describe("tintTowardsWhite", () => {
  it("mixes towards white by the given fraction", () => {
    expect(tintTowardsWhite("#2B2B76", 0.94)).toBe("#f2f2f7");
    expect(tintTowardsWhite("#2B2B76", 0.81)).toBe("#d7d7e5");
    expect(tintTowardsWhite("#2B2B76", 0)).toBe("#2b2b76");
    expect(tintTowardsWhite("#2B2B76", 1)).toBe("#ffffff");
  });

  it("passes an unparseable value through untouched", () => {
    expect(tintTowardsWhite("not-a-colour", 0.5)).toBe("not-a-colour");
  });
});
