import { describe, expect, it } from "vitest";
import { crewSize, extraCrew, jobCost, marginPct, boxesFromItems } from "@/lib/margin";
import type { BusinessSettings } from "@/lib/settings";

const RATES: BusinessSettings = {
  estimatorFee: 50,
  costFuelPerMile: 0.5,
  costLabourPerDay: 120,
  costBox: 2,
  costVanDay: 40,
  cost75t: 1800,
  costMisc: 30,
  vatDefault: true,
  baseLocation: "",
};

describe("crewSize", () => {
  it("derives from the van config", () => {
    expect(crewSize("1luton", 0)).toBe(2);
    expect(crewSize("2luton", 0)).toBe(3);
    expect(crewSize("3luton", 0)).toBe(4);
  });
  it("adds one per 7.5t lorry", () => {
    expect(crewSize("1luton", 1)).toBe(3);
    expect(crewSize("3luton", 1)).toBe(5);
    expect(crewSize("3luton", 2)).toBe(6); // two lorries → two more men
  });
});

describe("extraCrew (billed helpers = crew − one man per vehicle)", () => {
  it("is one helper in every standard config", () => {
    expect(extraCrew("1luton", 0)).toBe(1); // 2 crew − 1 van
    expect(extraCrew("2luton", 0)).toBe(1); // 3 crew − 2 vans
    expect(extraCrew("3luton", 0)).toBe(1); // 4 crew − 3 vans
    expect(extraCrew("1luton", 1)).toBe(1); // 3 crew − 2 vehicles
    expect(extraCrew("2luton", 2)).toBe(1); // 5 crew − 4 vehicles
  });
});

describe("jobCost", () => {
  it("labour bills only the extra crew; 7.5t excluded when not used", () => {
    const c = jobCost(
      { vehicle: "2luton", sevenFiveT: 0, totalMiles: 100, boxes: 40, days: 1 },
      RATES,
    );
    expect(c.labour).toBe(120); // 1 helper × 1 day × 120
    expect(c.vans).toBe(80); // 2 Lutons × 1 × 40
    expect(c.sevenT).toBe(0);
    expect(c.fuel).toBe(50); // 100 × 0.5
    expect(c.boxes).toBe(80); // 40 × 2
    expect(c.misc).toBe(30);
    expect(c.estimatorFee).toBe(50);
    expect(c.total).toBe(410);
  });

  it("adds the flat 7.5t cost (incl its man) without adding labour", () => {
    const c = jobCost(
      { vehicle: "2luton", sevenFiveT: 1, totalMiles: 0, boxes: 0, days: 1 },
      RATES,
    );
    expect(c.labour).toBe(120); // still 1 helper (the 7.5t man is in the lorry cost)
    expect(c.vans).toBe(80); // 2 Lutons only (7.5t not in van day rate)
    expect(c.sevenT).toBe(1800);
    expect(c.total).toBe(120 + 80 + 1800 + 30 + 50); // 2080
  });

  it("two 7.5t lorries cost 2× the per-lorry rate", () => {
    const c = jobCost(
      { vehicle: "2luton", sevenFiveT: 2, totalMiles: 0, boxes: 0, days: 1 },
      RATES,
    );
    expect(c.sevenT).toBe(3600); // 2 × 1800
    expect(c.labour).toBe(120); // still 1 billed helper (each lorry brings its own man)
  });

  it("scales labour + Luton vans with days; 7.5t stays flat", () => {
    const c = jobCost(
      { vehicle: "1luton", sevenFiveT: 1, totalMiles: 0, boxes: 0, days: 2 },
      RATES,
    );
    expect(c.labour).toBe(240); // 1 helper × 2 days × 120
    expect(c.vans).toBe(80); // 1 Luton × 2 days × 40
    expect(c.sevenT).toBe(1800); // flat per lorry, not ×days
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
