import { describe, expect, it } from "vitest";
import { seedAddress, streetPart } from "@/lib/leads/edit-address";

/**
 * QA-20260905-04 — editing ONLY a lead's postcode in the /leads/[id] Edit
 * dialog updated leads.from_postcode but left the OLD postcode embedded,
 * verbatim, in leads.from_address. The dialog seeded its structured address
 * state by dumping the RAW stored line into line1; since manually-entered
 * leads bake the postcode into that line (formatAddress on the create path),
 * line1 carried the old postcode as plain text and streetPart() faithfully
 * re-serialised it back into *_address on every save, whatever the separate
 * Postcode field said. seedAddress must therefore PARSE the stored line apart
 * so the postcode lives only in the postcode field.
 */
describe("seedAddress", () => {
  it("does not leave the stored line's baked-in postcode inside line1", () => {
    const a = seedAddress("12 test street, bournemouth, BH21 8NB", "BH21 8NB");
    expect(a.line1).toBe("12 test street");
    expect(a.town).toBe("bournemouth");
    expect(a.postcode).toBe("BH21 8NB");
  });

  it("postcode column wins when it disagrees with the text (the stale rows this bug already wrote)", () => {
    const a = seedAddress("12 test street, bournemouth, BH21 8NB", "SP7 9PX");
    expect(a.postcode).toBe("SP7 9PX");
    expect(a.line1).toBe("12 test street");
    expect(streetPart(a)).not.toContain("BH21 8NB");
  });

  it("website-sync shape (postcode stored separately) still splits street/town and fills the postcode", () => {
    const a = seedAddress("58 Stokehill, Trowbridge", "BA14 7TJ");
    expect(a.line1).toBe("58 Stokehill");
    expect(a.town).toBe("Trowbridge");
    expect(a.postcode).toBe("BA14 7TJ");
  });

  it("blank address with only a postcode seeds just the postcode", () => {
    const a = seedAddress("", "SP7 9PX");
    expect(a.line1).toBe("");
    expect(a.postcode).toBe("SP7 9PX");
  });
});

/**
 * The postcode-only-edit round trip: seed from the stored columns, change
 * nothing but the postcode, and the street part written back to *_address must
 * no longer carry the old postcode text — the two columns can never disagree
 * again after a save.
 */
describe("postcode-only edit round trip", () => {
  it("re-serialises *_address without the old postcode", () => {
    const seeded = seedAddress("12 test street, bournemouth, BH21 8NB", "BH21 8NB");
    const edited = { ...seeded, postcode: "SP7 9PX" };
    expect(streetPart(edited)).toBe("12 test street, bournemouth");
  });

  it("keeps a county segment in the street part", () => {
    const seeded = seedAddress("12 High Street, Bath, Somerset, BA1 1AA", "BA1 1AA");
    expect(streetPart(seeded)).toBe("12 High Street, Bath, Somerset");
  });
});
