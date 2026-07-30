import { describe, expect, it } from "vitest";
import {
  ITEM_FIELDS,
  ZERO_ITEMS,
  buildOpItems,
  normalizeQuoteValues,
  type QuoteItems,
} from "@/lib/quote/form-types";

describe("buildOpItems", () => {
  const labels = (items: QuoteItems) => buildOpItems(items).map((i) => i.label);

  it("includes the piano items when qty > 0 and excludes them at 0", () => {
    expect(labels(ZERO_ITEMS)).toEqual([]);
    const withPiano = { ...ZERO_ITEMS, babyGrandPianoCover: 1, babyGrandPianoShoe: 2, pianoDolly: 1 };
    expect(labels(withPiano)).toEqual(["Baby Grand Piano Cover", "Baby Grand Piano Shoe", "Piano Dolly"]);
    expect(buildOpItems(withPiano).find((i) => i.label === "Baby Grand Piano Shoe")?.qty).toBe(2);
  });

  it("keeps zero quantities out of the op list", () => {
    expect(labels({ ...ZERO_ITEMS, boxesBefore: 10, pianoDolly: 0 })).toEqual(["Boxes Before Move"]);
  });
});

describe("ITEM_FIELDS", () => {
  it("covers every QuoteItems key exactly once (wizard stays in sync with the type)", () => {
    const keys = ITEM_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(ZERO_ITEMS).sort());
  });

  it("both box counts step in 5s; every other item defaults to 1", () => {
    // Boxes are counted in fives in the field (Peter, 2026-07-30 — boxesOnCollection
    // joined boxesBefore); the covers/piano items still step by 1.
    const fives = new Set(["boxesBefore", "boxesOnCollection"]);
    for (const f of ITEM_FIELDS) {
      if (fives.has(f.key)) expect(f.step).toBe(5);
      else expect(f.step ?? 1).toBe(1);
    }
  });

  it("groups the piano items under Piano", () => {
    const piano = ITEM_FIELDS.filter((f) => f.group === "Piano").map((f) => f.key);
    expect(piano).toEqual(["babyGrandPianoCover", "babyGrandPianoShoe", "pianoDolly"]);
  });
});

describe("normalizeQuoteValues — items", () => {
  it("fills the new piano keys with 0 on legacy blobs", () => {
    const v = normalizeQuoteValues({ items: { wardrobeBoxes: 3 } });
    expect(v.items.wardrobeBoxes).toBe(3);
    expect(v.items.babyGrandPianoCover).toBe(0);
    expect(v.items.babyGrandPianoShoe).toBe(0);
    expect(v.items.pianoDolly).toBe(0);
  });
});
