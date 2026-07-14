import { describe, expect, it } from "vitest";
import { computeQuote, DEFAULT_PRICING, type QuoteInputs } from "@/lib/quote/pricing";
import { customerLineItems } from "@/lib/quote/line-items";

/**
 * customerLineItems() is the presentation-layer grouping the customer sees. It
 * must (1) fold the fleet base lines + admin fee into one "Your Removal" line,
 * (2) never reveal a van count or crew size, and (3) still reconcile to the
 * penny — its rows sum EXACTLY to the subtotal and never move the grand total.
 * Money is NEVER recomputed here (computeQuote owns that); these tests prove the
 * grouping is faithful.
 */

const COUNT_LEAK = /\bvans?\b|\bmen\b|\bcrew\b|\d+\s*x\s*(luton|van)/i;

/** Kitchen-sink inputs — every charge type switched on, multi-vehicle, fractional mileage. */
function kitchenSink(overrides: Partial<QuoteInputs> = {}) {
  const pricing = { ...DEFAULT_PRICING, extraDayRate: 400 };
  return computeQuote(
    {
      vehicle: "2luton",
      packing: "full",
      sevenFiveT: 2,
      transitVans: 1,
      days: 3,
      deadMiles: 9.7,
      jobMiles: 9.7,
      collectAccessM: 15,
      destAccessM: 25,
      collectType: "flat",
      collectFloor: "2nd",
      destType: "flat",
      destFloor: "1st",
      congestion: true,
      tolls: 12.34,
      parking: 5,
      discount: 100,
      vatEnabled: true,
      ...overrides,
    },
    pricing,
  );
}

describe("customerLineItems — customer-facing quote grouping", () => {
  it("(a) 'Your Removal' = vehicle base(s) + admin fee (+ 7.5t base) to the penny", () => {
    const b = kitchenSink();
    const items = customerLineItems(b);
    const yourRemoval = items.find((it) => it.label === "Your Removal");
    expect(yourRemoval).toBeTruthy();
    // base (Luton) + 7.5t base + add-on Transit base + admin fee
    const expected = b.base + b.addon75Cost + b.transitCost + b.adminFee;
    expect(yourRemoval!.amount).toBeCloseTo(expected, 6);
    expect(yourRemoval!.unit).toBeCloseTo(expected, 6);
    // and it genuinely INCLUDES the admin fee (not a separate line)
    expect(b.adminFee).toBeGreaterThan(0);
    expect(items.some((it) => /admin/i.test(it.label))).toBe(false);
  });

  it("'Your Removal' still folds in the fleet bases on a Luton-only quote (no 7.5t / transit)", () => {
    const b = kitchenSink({ sevenFiveT: 0, transitVans: 0, vehicle: "1luton" });
    const items = customerLineItems(b);
    const yourRemoval = items.find((it) => it.label === "Your Removal")!;
    expect(yourRemoval.amount).toBeCloseTo(b.base + b.adminFee, 6);
    expect(b.addon75Cost).toBe(0);
    expect(b.transitCost).toBe(0);
  });

  it("(b) rows sum EXACTLY to the subtotal for a kitchen-sink quote", () => {
    const b = kitchenSink();
    const items = customerLineItems(b);
    const sum = items.reduce((acc, it) => acc + it.amount, 0);
    expect(sum).toBeCloseTo(b.subtotal, 6);
  });

  it("(c) no customer label or detail reveals a van count / crew size", () => {
    // Sweep multiple fleet shapes so every branch's copy is exercised.
    const shapes: Partial<QuoteInputs>[] = [
      {},
      { sevenFiveT: 0, transitVans: 0, vehicle: "1luton" },
      { sevenFiveT: 1, transitVans: 0, vehicle: "5luton" },
      { sevenFiveT: 0, transitVans: 1, vehicle: "transit", congestion: true, collectType: "flat", collectFloor: "3rd" },
    ];
    for (const s of shapes) {
      for (const it of customerLineItems(kitchenSink(s))) {
        expect(it.label, `label leaked: ${it.label}`).not.toMatch(COUNT_LEAK);
        expect(it.detail, `detail leaked: ${it.detail}`).not.toMatch(COUNT_LEAK);
      }
    }
  });

  it("(d) grand total is unchanged vs computeQuote (grouping is presentation-only)", () => {
    const b = kitchenSink();
    const items = customerLineItems(b);
    const sum = items.reduce((acc, it) => acc + it.amount, 0);
    // subtotal → (− discount) → (× VAT) must still land on the engine's grand total.
    const rebuilt = (sum - b.discount) * (b.vatEnabled ? 1.2 : 1);
    expect(rebuilt).toBeCloseTo(b.grandTotal, 6);
    expect(sum).toBeCloseTo(b.subtotal, 6);
  });

  it("every misc cost keeps its own itemised line (packing, mileage, access, floor, congestion, tolls, parking)", () => {
    const labels = customerLineItems(kitchenSink()).map((it) => it.label);
    for (const l of [
      "Your Removal",
      "Packing Service",
      "Additional Days",
      "Mileage",
      "Collection Access",
      "Destination Access",
      "Collection Floor Charge",
      "Destination Floor Charge",
      "Congestion Charge",
      "Toll Charges",
      "Parking Permit",
    ]) {
      expect(labels, `missing line: ${l}`).toContain(l);
    }
  });
});
