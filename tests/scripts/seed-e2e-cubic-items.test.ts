import { describe, expect, it } from "vitest";
import { catalogueItem } from "@/lib/cubic-catalogue";
import { computeCubicTotals, sanitizeCubicLines } from "@/lib/cubic-survey";
import { CUBIC_SURVEY_SEED_ITEMS } from "../../scripts/seed-e2e-fixtures.mjs";

/**
 * QA-20260819-02: the e2e seed wrote cubic_surveys.items in a shape
 * sanitizeCubicLines() rejects ({ key, label, qty, ft3 }), so a customer
 * opening the seeded /cv/<token> survey could never submit — the action
 * re-validates the STORED row and turned the null into the generic
 * "needs attention" message. This pins the seed literal to the CubicLine
 * contract so the shape cannot drift again.
 */
describe("e2e cubic-survey seed items", () => {
  it("pass sanitizeCubicLines exactly as stored (the customer submit gate)", () => {
    const sanitized = sanitizeCubicLines(CUBIC_SURVEY_SEED_ITEMS);
    expect(sanitized).not.toBeNull();
    expect(sanitized).toHaveLength(CUBIC_SURVEY_SEED_ITEMS.length);
    // Identity must survive sanitisation untouched — a regenerated id or
    // coerced field would mean the seed row differs from what the app reads.
    for (const [i, line] of sanitized!.entries()) {
      const seeded = CUBIC_SURVEY_SEED_ITEMS[i];
      expect(line.id).toBe(seeded.id);
      expect(line.key).toBe(seeded.key);
      expect(line.title).toBe(seeded.title);
      expect(line.category).toBe(seeded.category);
      expect(line.qty).toBe(seeded.qty);
      expect(line.unitFt3).toBe(seeded.unitFt3);
    }
  });

  it("matches the real catalogue entry it claims to be", () => {
    for (const seeded of CUBIC_SURVEY_SEED_ITEMS) {
      const cat = catalogueItem(seeded.key);
      expect(cat, `unknown catalogue key ${seeded.key}`).toBeDefined();
      expect(seeded.title).toBe(cat!.title);
      expect(seeded.unitFt3).toBe(cat!.ft3);
    }
  });

  it("totals to the volume the seeded survey advertises", () => {
    const totals = computeCubicTotals(sanitizeCubicLines(CUBIC_SURVEY_SEED_ITEMS)!);
    expect(totals.totalFt3).toBe(35);
    expect(totals.itemCount).toBe(1);
  });
});
