import { describe, expect, it } from "vitest";
import {
  ITEM_FIELDS,
  ZERO_ITEMS,
  buildOpItems,
  defaultQuoteValues,
  deriveInputs,
  normalizeQuoteValues,
  type QuoteItems,
} from "@/lib/quote/form-types";
import { computeQuote } from "@/lib/quote/pricing";

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

/* ---------------------------------- gate 7: the Additional Charges uplift */

/**
 * The builder's money chain is
 *   state_blob -> normalizeQuoteValues -> deriveInputs -> computeQuote -> displayed total
 * and `computeQuote` is already locked hard by pricing.test.ts. The UNTESTED link was
 * `deriveInputs`, which is the single line that carries the wizard's Additional Charges
 * field into the priced inputs. Delete that line and every computeQuote assertion still
 * passes — they call computeQuote directly — while the feature silently does nothing in
 * the UI. These tests cover that link, and the round trip the office actually performs:
 * type an uplift, watch the total move, clear it, watch the total come back.
 */
describe("deriveInputs — Additional Charges reaches the priced inputs (PRD §3.9)", () => {
  const priceable = () => {
    const v = defaultQuoteValues();
    v.customer.name = "Uplift Test";
    v.customer.email = "uplift@marleymoves.test";
    return v;
  };

  it("carries review.additionalCharges through to QuoteInputs", () => {
    const v = priceable();
    v.review.additionalCharges = 175.5;
    expect(deriveInputs(v).additionalCharges).toBe(175.5);
  });

  it("a blank quote derives 0, never NaN or undefined", () => {
    expect(deriveInputs(defaultQuoteValues()).additionalCharges).toBe(0);
  });

  it("a legacy state_blob written before migration 0105 derives 0, not NaN", () => {
    // Old quotes have a `review` object with no additionalCharges key at all.
    const v = normalizeQuoteValues({ review: { discount: 50, quoteNotes: "old" } });
    expect(v.review.additionalCharges).toBe(0);
    expect(deriveInputs(v).additionalCharges).toBe(0);
    // and the discount that WAS stored survives the normalise:
    expect(v.review.discount).toBe(50);
  });

  it("a garbage value derives 0 rather than poisoning the total with NaN", () => {
    const v = priceable();
    // @ts-expect-error deliberately simulating a hand-edited / legacy blob
    v.review.additionalCharges = "not a number";
    expect(deriveInputs(v).additionalCharges).toBe(0);
    expect(Number.isFinite(computeQuote(deriveInputs(v)).grandTotal)).toBe(true);
  });

  it("uplift -> totals -> revert: the total moves by exactly the uplift and returns", () => {
    const v = priceable();

    const baseline = computeQuote(deriveInputs(v));
    expect(baseline.additionalCharges).toBe(0);

    v.review.additionalCharges = 250;
    const raised = computeQuote(deriveInputs(v));
    expect(raised.additionalCharges).toBe(250);
    expect(raised.subtotal).toBe(baseline.subtotal + 250);
    expect(raised.grandTotal).toBe(baseline.grandTotal + 250);

    // Reverting is not "close enough" — it must restore the pre-uplift quote
    // exactly, because the office reverts a mistyped uplift and re-sends.
    v.review.additionalCharges = 0;
    expect(computeQuote(deriveInputs(v))).toEqual(baseline);
  });

  it("the uplift is inside the VAT base, like every other charge", () => {
    const v = priceable();
    v.vatEnabled = true;
    const before = computeQuote(deriveInputs(v));
    v.review.additionalCharges = 100;
    const after = computeQuote(deriveInputs(v));
    // 20% of the added 100 lands in VAT, and the gross moves by the full 120.
    expect(after.vatAmount).toBeCloseTo(before.vatAmount + 20, 10);
    expect(after.grandTotal).toBeCloseTo(before.grandTotal + 120, 10);
  });

  it("the REASON never reaches the priced inputs or the breakdown", () => {
    const v = priceable();
    v.review.additionalCharges = 40;
    v.review.additionalChargesReason = "commercial access";
    const inputs = deriveInputs(v);
    expect(inputs).not.toHaveProperty("additionalChargesReason");
    expect(JSON.stringify(computeQuote(inputs))).not.toContain("commercial access");
  });
});
