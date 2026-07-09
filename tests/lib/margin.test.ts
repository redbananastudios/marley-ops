import { describe, expect, it } from "vitest";
import { crewSize, jobCost, marginPct, boxesFromItems } from "@/lib/margin";
import type { BusinessSettings } from "@/lib/settings";

const RATES: BusinessSettings = {
  estimatorFee: 50,
  costFuelPerMile: 0.5,
  costFuel75PerMile: 0.5,
  costLabourPerDay: 120,
  costBox: 2,
  costVanDay: 40,
  costTransitDay: 25,
  cost75t: 1800,
  costMisc: 30,
  vatDefault: true,
  vatNumber: "",
  baseLocation: "",
  googleReviewUrl: "",
  defaultDeposit: 0,
};

describe("crewSize", () => {
  it("derives from the van config (vans + 1)", () => {
    expect(crewSize("1luton", 0)).toBe(2);
    expect(crewSize("2luton", 0)).toBe(3);
    expect(crewSize("3luton", 0)).toBe(4);
    expect(crewSize("4luton", 0)).toBe(5);
    expect(crewSize("5luton", 0)).toBe(6);
  });
  it("adds one man per 7.5t lorry by default", () => {
    expect(crewSize("1luton", 1)).toBe(3);
    expect(crewSize("3luton", 1)).toBe(5);
    expect(crewSize("3luton", 2)).toBe(6); // two lorries → two more men
  });
  it("adds two men per 7.5t lorry with the second-man option", () => {
    expect(crewSize("1luton", 1, true)).toBe(4); // 2 + 1×2
    expect(crewSize("2luton", 2, true)).toBe(7); // 3 + 2×2
  });
  it("transit tier is a single man; add-on transits add one man each", () => {
    expect(crewSize("transit", 0)).toBe(1);
    expect(crewSize("transit", 0, false, 1)).toBe(2); // transit tier + 1 add-on transit
    expect(crewSize("2luton", 0, false, 2)).toBe(5); // 3 + 2 transit men
  });
});

describe("jobCost", () => {
  it("labour bills the full crew; 7.5t excluded when not used", () => {
    const c = jobCost(
      { vehicle: "2luton", sevenFiveT: 0, totalMiles: 100, boxes: 40, days: 1 },
      RATES,
    );
    expect(c.labour).toBe(360); // 3 men × 1 day × 120
    expect(c.vans).toBe(80); // 2 Lutons × 1 × 40
    expect(c.sevenT).toBe(0);
    expect(c.fuel).toBe(100); // 100mi × 0.5 × 2 Lutons
    expect(c.fuel75).toBe(0); // no 7.5t
    expect(c.boxes).toBe(80); // 40 × 2
    expect(c.misc).toBe(30);
    expect(c.estimatorFee).toBe(50);
    expect(c.total).toBe(700); // 360 + 80 + 100 + 80 + 30 + 50
  });

  it("fuel scales with both the Luton count and a separate 7.5t rate", () => {
    const c = jobCost(
      { vehicle: "3luton", sevenFiveT: 1, totalMiles: 100, boxes: 0, days: 1 },
      { ...RATES, costFuelPerMile: 0.4, costFuel75PerMile: 0.6 },
    );
    expect(c.fuel).toBe(120); // 100mi × 0.4 × 3 Lutons
    expect(c.fuel75).toBe(60); // 100mi × 0.6 × 1 lorry
  });

  it("a 7.5t adds its man to labour + the flat lorry cost", () => {
    const c = jobCost(
      { vehicle: "2luton", sevenFiveT: 1, totalMiles: 0, boxes: 0, days: 1 },
      RATES,
    );
    expect(c.labour).toBe(480); // 4 men (3 + 1) × 120
    expect(c.vans).toBe(80); // 2 Lutons only
    expect(c.sevenT).toBe(1800);
    expect(c.total).toBe(480 + 80 + 1800 + 30 + 50); // 2440
  });

  it("a second man on the 7.5t bills two men for that lorry", () => {
    const c = jobCost(
      { vehicle: "2luton", sevenFiveT: 1, sevenFiveTSecondMan: true, totalMiles: 0, boxes: 0, days: 1 },
      RATES,
    );
    expect(c.labour).toBe(600); // 5 men (3 + 2) × 120
    expect(c.sevenT).toBe(1800); // lorry cost unchanged
  });

  it("two 7.5t lorries cost 2× the per-lorry rate and add two men", () => {
    const c = jobCost(
      { vehicle: "2luton", sevenFiveT: 2, totalMiles: 0, boxes: 0, days: 1 },
      RATES,
    );
    expect(c.sevenT).toBe(3600); // 2 × 1800
    expect(c.labour).toBe(600); // 5 men (3 + 2) × 120
  });

  it("scales labour + Luton vans with days; 7.5t stays flat", () => {
    const c = jobCost(
      { vehicle: "1luton", sevenFiveT: 1, totalMiles: 0, boxes: 0, days: 2 },
      RATES,
    );
    expect(c.labour).toBe(720); // 3 men × 2 days × 120
    expect(c.vans).toBe(80); // 1 Luton × 2 days × 40
    expect(c.sevenT).toBe(1800); // flat per lorry, not ×days
  });
});

describe("jobCost — transit", () => {
  it("transit tier: 1 man, 1 transit vehicle at the transit day rate, no Luton cost", () => {
    const c = jobCost(
      { vehicle: "transit", sevenFiveT: 0, totalMiles: 100, boxes: 0, days: 1 },
      RATES,
    );
    expect(c.labour).toBe(120); // 1 man × 120
    expect(c.vans).toBe(0); // no Lutons
    expect(c.transits).toBe(25); // 1 transit × 25 × 1 day
    expect(c.fuel).toBe(50); // 100mi × 0.5 × 1 vehicle
  });

  it("add-on transit on a Luton job adds its vehicle, man and fuel", () => {
    const c = jobCost(
      { vehicle: "2luton", sevenFiveT: 0, transitVans: 1, totalMiles: 100, boxes: 0, days: 1 },
      RATES,
    );
    expect(c.labour).toBe(480); // 4 men (3 + 1 transit man) × 120
    expect(c.vans).toBe(80); // 2 Lutons × 40
    expect(c.transits).toBe(25); // 1 transit × 25
    expect(c.fuel).toBe(150); // 100mi × 0.5 × 3 vehicles (2 Lutons + 1 transit)
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
