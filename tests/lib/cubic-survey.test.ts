import { describe, expect, it } from "vitest";
import { CUBIC_CATEGORIES, catalogueItem } from "@/lib/cubic-catalogue";
import {
  computeCubicTotals,
  DEFAULT_CAPACITIES,
  ft3ToM3,
  MAX_LINES,
  recommendVans,
  sanitizeCubicLines,
  vehicleShortLabel,
  type CubicLine,
} from "@/lib/cubic-survey";

const line = (over: Partial<CubicLine> = {}): CubicLine => ({
  key: "living-space:sofa-2-seater",
  title: "Sofa 2 seater",
  category: "living-space",
  qty: 1,
  unitFt3: 35,
  ...over,
});

describe("catalogue integrity (the 218 iMVE measurements)", () => {
  it("carries every category with unique keys and positive values", () => {
    expect(CUBIC_CATEGORIES.map((c) => c.key)).toEqual([
      "living-space",
      "loft",
      "bedrooms",
      "garage-garden-area",
      "kitchen-and-utility",
      "office-and-commercial",
    ]);
    const keys = new Set<string>();
    let total = 0;
    for (const c of CUBIC_CATEGORIES) {
      for (const i of c.items) {
        expect(keys.has(i.key), `duplicate key ${i.key}`).toBe(false);
        keys.add(i.key);
        expect(i.ft3, `${i.title} value`).toBeGreaterThan(0);
        total++;
      }
    }
    expect(total).toBe(218);
  });

  it("spot-checks the values Connor's account uses", () => {
    expect(catalogueItem("living-space:sofa-2-seater")?.ft3).toBe(35);
    expect(catalogueItem("living-space:grand-piano")?.ft3).toBe(150);
    expect(catalogueItem("bedrooms:wardrobe-double")?.ft3).toBe(40);
    expect(catalogueItem("garage-garden-area:single-garage-full")?.ft3).toBe(800);
    expect(catalogueItem("kitchen-and-utility:fridge-freezer-american")?.ft3).toBe(80);
  });
});

describe("computeCubicTotals", () => {
  it("sums qty × unit, groups by category, converts to m³", () => {
    const t = computeCubicTotals([
      line({ qty: 2 }), // 70
      line({ key: "bedrooms:wardrobe-double", title: "Wardrobe double", category: "bedrooms", qty: 1, unitFt3: 40 }),
    ]);
    expect(t.totalFt3).toBe(110);
    expect(t.itemCount).toBe(3);
    expect(t.byCategory).toEqual([
      { category: "living-space", ft3: 70, items: 2 },
      { category: "bedrooms", ft3: 40, items: 1 },
    ]);
    expect(t.totalM3).toBe(ft3ToM3(110));
  });

  it("'not moving' lines are recorded but NEVER counted; flags tally by qty", () => {
    const t = computeCubicTotals([
      line({ qty: 2, flags: { notMoving: true } }),
      line({ key: "x", title: "Piano", category: "living-space", qty: 1, unitFt3: 70, flags: { dismantle: true, fragile: true } }),
    ]);
    expect(t.totalFt3).toBe(70);
    expect(t.notMovingCount).toBe(2);
    expect(t.dismantleCount).toBe(1);
    expect(t.fragileCount).toBe(1);
  });

  it("a staying item creates no crew work: notMoving suppresses its dismantle/fragile tallies", () => {
    const t = computeCubicTotals([
      line({ qty: 3, flags: { notMoving: true, dismantle: true, fragile: true } }),
    ]);
    expect(t.notMovingCount).toBe(3);
    expect(t.dismantleCount).toBe(0);
    expect(t.fragileCount).toBe(0);
    expect(t.totalFt3).toBe(0);
  });
});

describe("recommendVans", () => {
  it("small volumes fit the Transit; nothing → null", () => {
    expect(recommendVans(0)).toBeNull();
    const r = recommendVans(200, DEFAULT_CAPACITIES)!; // usable transit = 252
    expect(r.vehicleKey).toBe("transit");
    expect(vehicleShortLabel(r)).toBe("Transit van");
  });

  it("sizes Lutons at the fill factor: 812 ft³ → 2 Lutons at 90% of 550", () => {
    const r = recommendVans(812, DEFAULT_CAPACITIES)!;
    expect(r.vehicleKey).toBe("2luton"); // 812 / 495 = 1.64 → 2
    expect(r.lutonCount).toBe(2);
    expect(r.consider75t).toBe(false);
    expect(r.fillOfRecommendationPct).toBe(82);
  });

  it("flags the 7.5t from 3 Lutons (with its load count from the 7.5t capacity) and caps at 5", () => {
    const three = recommendVans(1200, DEFAULT_CAPACITIES)!; // 3 Lutons
    expect(three.consider75t).toBe(true);
    expect(three.sevenFiveTLoads).toBe(1); // 1200 ≤ 1400 × 0.9 = 1260
    expect(three.label).toContain("fits 1 × 7.5t");
    const big = recommendVans(4000, DEFAULT_CAPACITIES)!;
    expect(big.vehicleKey).toBe("5luton");
    expect(big.sevenFiveTLoads).toBe(4); // 4000 / 1260 → 4
    expect(big.label).toContain("exceeds 5 Lutons");
  });

  it("a boundary volume exactly at usable capacity stays in the smaller combo", () => {
    const r = recommendVans(495, DEFAULT_CAPACITIES)!; // exactly 1 Luton usable
    expect(r.vehicleKey).toBe("1luton");
    expect(r.fillOfRecommendationPct).toBe(100);
  });
});

describe("sanitizeCubicLines (the server gate)", () => {
  it("accepts clean lines and normalises flags/rounding", () => {
    const out = sanitizeCubicLines([{ ...line(), unitFt3: 35.567, flags: { dismantle: true }, note: " careful " }])!;
    expect(out[0].unitFt3).toBe(35.6);
    expect(out[0].flags).toEqual({ dismantle: true, fragile: false, notMoving: false });
    expect(out[0].note).toBe("careful");
  });

  it("rejects junk: bad qty, huge values, missing fields, oversize lists", () => {
    expect(sanitizeCubicLines([line({ qty: 0 })])).toBeNull();
    expect(sanitizeCubicLines([line({ qty: 1000 })])).toBeNull();
    expect(sanitizeCubicLines([line({ unitFt3: 2001 })])).toBeNull();
    expect(sanitizeCubicLines([{ ...line(), title: "" }])).toBeNull();
    expect(sanitizeCubicLines([line({ unitFt3: Number.NaN })])).toBeNull();
    expect(sanitizeCubicLines(Array.from({ length: MAX_LINES + 1 }, () => line()))).toBeNull();
    expect(sanitizeCubicLines("nope")).toBeNull();
  });
});
