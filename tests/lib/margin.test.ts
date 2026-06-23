import { describe, expect, it } from "vitest";
import { crewSize, jobCost, marginPct, boxesFromItems } from "@/lib/margin";
import type { BusinessSettings } from "@/lib/settings";

const RATES: BusinessSettings = {
  estimatorFee: 50,
  costFuelPerMile: 0.5,
  costLabourPerDay: 120,
  costBox: 2,
  costVanDay: 40,
  costMisc: 30,
};

describe("crewSize", () => {
  it("derives from the van config", () => {
    expect(crewSize("1luton", false)).toBe(2);
    expect(crewSize("2luton", false)).toBe(3);
    expect(crewSize("3luton", false)).toBe(4);
  });
  it("adds one for the 7.5t", () => {
    expect(crewSize("1luton", true)).toBe(3);
    expect(crewSize("3luton", true)).toBe(5);
  });
});

describe("jobCost", () => {
  it("sums labour (crew×days×rate) + vans + fuel + boxes + misc + estimator fee", () => {
    const c = jobCost(
      { vehicle: "2luton", has75T: false, vanCount: 2, totalMiles: 100, boxes: 40, days: 1 },
      RATES,
    );
    expect(c.labour).toBe(360); // 3 crew × 1 day × 120
    expect(c.vans).toBe(80); // 2 × 1 × 40
    expect(c.fuel).toBe(50); // 100 × 0.5
    expect(c.boxes).toBe(80); // 40 × 2
    expect(c.misc).toBe(30);
    expect(c.estimatorFee).toBe(50);
    expect(c.total).toBe(650);
  });

  it("scales labour + vans with days", () => {
    const c = jobCost(
      { vehicle: "1luton", has75T: false, vanCount: 1, totalMiles: 0, boxes: 0, days: 2 },
      RATES,
    );
    expect(c.labour).toBe(480); // 2 crew × 2 days × 120
    expect(c.vans).toBe(80); // 1 × 2 × 40
  });
});

describe("marginPct", () => {
  it("is margin over revenue, rounded", () => {
    expect(marginPct(1000, 650)).toBe(35);
    expect(marginPct(0, 100)).toBe(0);
  });
});

describe("boxesFromItems", () => {
  it("sums the box-type items only", () => {
    expect(boxesFromItems({ wardrobeBoxes: 5, boxesBefore: 10, boxesOnCollection: 15, mirrorsQty: 3 })).toBe(30);
    expect(boxesFromItems(null)).toBe(0);
  });
});
