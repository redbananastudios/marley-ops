import { describe, expect, it } from "vitest";
import { boxesFromItems, commissionCost, crewSize, jobCost, marginPct, marginRevenue } from "@/lib/margin";
import { computeQuote, type QuoteInputs } from "@/lib/quote/pricing";
import type { BusinessSettings } from "@/lib/settings";

const RATES: BusinessSettings = {
  estimatorFee: 50,
  estimatorPhoneQuoteFee: 10,
  estimatorCommissionPct: 7.5,
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
  vatStaggerGroup: 1,
  vatScheme: "flat_rate",
  vatFlatRatePct: 10,
  baseLocation: "",
  googleReviewUrl: "",
  defaultDeposit: 0,
  smallJobThreshold: 300,
  cubicFillPct: 90,
  cubicTransitFt3: 280,
  cubicLutonFt3: 550,
  cubic75tFt3: 1400,
  aiSurveyEnabled: false,
  aiGroundedReplayEnabled: false,
  aiModelDefault: "gemini-3.5-flash",
  aiModelEscalation: "gemini-3.5-flash",
  aiSurveyCapGbp: 2,
  aiMonthlyCapGbp: 50,
  aiMonthlyAlertGbp: 40,
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

describe("marginRevenue (strip pass-through VAT before margin)", () => {
  it("flat-rate scheme: removes only the flat % owed to HMRC, keeping the FRS surplus", () => {
    // £1,200 gross (£1,000 + £200 VAT) on the FRS at 9%: HMRC gets 9% of gross = £108,
    // so revenue kept for margin = £1,092 (NOT the ex-20%-VAT £1,000).
    expect(marginRevenue(1200, true, { ...RATES, vatScheme: "flat_rate", vatFlatRatePct: 9 })).toBeCloseTo(1092, 6);
    // Worked example: £600 rate-card cost → margin £492, ~45% of the £1,092 kept.
    const rev = marginRevenue(1200, true, { ...RATES, vatScheme: "flat_rate", vatFlatRatePct: 9 });
    expect(rev - 600).toBeCloseTo(492, 6);
    expect(marginPct(rev, 600)).toBe(45);
  });

  it("standard scheme: strips the full 20% charged (net = gross / 1.2)", () => {
    expect(marginRevenue(1200, true, { ...RATES, vatScheme: "standard" })).toBeCloseTo(1000, 6);
  });

  it("VAT-exclusive quote: nothing to strip — gross is already the margin revenue", () => {
    expect(marginRevenue(1000, false, RATES)).toBe(1000);
    expect(marginRevenue(1000, false, { ...RATES, vatScheme: "standard" })).toBe(1000);
  });

  it("guards zero / negative gross", () => {
    expect(marginRevenue(0, true, RATES)).toBe(0);
    expect(marginRevenue(-50, true, RATES)).toBe(0);
  });

  it("does NOT treat pass-through VAT as profit (regression on the old gross-vs-net-cost bug)", () => {
    // The bug showed £1,200 gross vs £600 cost = 50%. The FRS-correct figure is lower.
    const buggy = marginPct(1200, 600); // old behaviour
    const fixed = marginPct(marginRevenue(1200, true, { ...RATES, vatFlatRatePct: 9 }), 600);
    expect(buggy).toBe(50);
    expect(fixed).toBeLessThan(buggy);
    expect(fixed).toBe(45);
  });
});

describe("boxesFromItems", () => {
  it("sums the box-type items only", () => {
    expect(boxesFromItems({ wardrobeBoxes: 5, boxesBefore: 10, boxesOnCollection: 15, mirrorsQty: 3 })).toBe(30);
    expect(boxesFromItems(null)).toBe(0);
  });
});

describe("commissionCost (3rd-party lead referral fee as a job cost)", () => {
  it("passes positive commissions through, including Postgres numeric strings", () => {
    expect(commissionCost(50)).toBe(50);
    expect(commissionCost("75.50")).toBe(75.5);
  });
  it("absent, zero, negative or garbled values cost nothing", () => {
    expect(commissionCost(null)).toBe(0);
    expect(commissionCost(undefined)).toBe(0);
    expect(commissionCost(0)).toBe(0);
    expect(commissionCost(-10)).toBe(0);
    expect(commissionCost("not-a-number")).toBe(0);
  });
  it("reduces the margin exactly by the commission", () => {
    // £1,000 job, £650 rate-card cost, £100 referral fee → 25% not 35%.
    expect(marginPct(1000, 650 + commissionCost(100))).toBe(25);
  });
});

describe("additional charges count as revenue exactly ONCE (PRD §3.9, no double-count)", () => {
  const inputs = (additionalCharges: number): QuoteInputs => ({
    vehicle: "1luton",
    packing: "owner",
    deadMiles: null,
    jobMiles: null,
    collectAccessM: 0,
    destAccessM: 0,
    collectType: "house",
    collectFloor: "ground",
    destType: "house",
    destFloor: "ground",
    congestion: false,
    tolls: 0,
    parking: 0,
    additionalCharges,
    discount: 0,
    vatEnabled: false,
  });

  it("margin revenue derives from gross, which already carries the uplift — no separate term", () => {
    // The uplift lives INSIDE grand_total (computeQuote prices it into the
    // subtotal), and marginRevenue reads only that gross — so revenue moves by
    // exactly the uplift, once. A second uplift term anywhere in the margin
    // maths would make this delta 2× the uplift.
    const plain = computeQuote(inputs(0));
    const uplifted = computeQuote(inputs(250));
    expect(uplifted.grandTotal - plain.grandTotal).toBe(250);
    const revPlain = marginRevenue(plain.grandTotal, false, RATES);
    const revUplifted = marginRevenue(uplifted.grandTotal, false, RATES);
    expect(revUplifted - revPlain).toBeCloseTo(250, 6);
  });

  it("with VAT on, the uplift's revenue contribution is its ex-VAT-liability share, like every other charge", () => {
    // Standard scheme: gross moves by 250 × 1.2 = 300; revenue by 300 / 1.2 = 250.
    const s: BusinessSettings = { ...RATES, vatScheme: "standard" };
    const plain = computeQuote({ ...inputs(0), vatEnabled: true });
    const uplifted = computeQuote({ ...inputs(250), vatEnabled: true });
    expect(uplifted.grandTotal - plain.grandTotal).toBeCloseTo(300, 6);
    const delta = marginRevenue(uplifted.grandTotal, true, s) - marginRevenue(plain.grandTotal, true, s);
    expect(delta).toBeCloseTo(250, 6);
  });

  it("cost side never reads the uplift — jobCost is rate-card only", () => {
    // Same job shape → same cost, whatever the uplift; the uplift is pure margin.
    const cost = jobCost({ vehicle: "1luton", sevenFiveT: 0, totalMiles: 0, boxes: 0, days: 1 }, RATES);
    expect(cost.total).toBeGreaterThan(0);
    // jobCost's inputs carry no additional-charges field at all — the type makes
    // the double-count structurally impossible; this test documents that intent.
  });
});
