import { describe, expect, it } from "vitest";
import { classifyPendingClaim } from "@/lib/storage/raise-storage-invoices";

/**
 * The adopt-or-flag decision for a pending storage-invoice claim whose Zoho
 * orphan was found by reference. Money rule: adopt only when the Zoho total
 * matches the claimed amount within a rounding whisker (±£0.005) — anything
 * beyond goes to a human, never an auto-adopt.
 */
describe("classifyPendingClaim", () => {
  it("adopts an exact total match", () => {
    expect(classifyPendingClaim({ zohoTotal: 156, amount: 156 })).toBe("adopt");
    expect(classifyPendingClaim({ zohoTotal: 84.5, amount: 84.5 })).toBe("adopt");
  });

  it("adopts within the ±£0.005 rounding tolerance (boundary inclusive)", () => {
    expect(classifyPendingClaim({ zohoTotal: 100.005, amount: 100 })).toBe("adopt");
    expect(classifyPendingClaim({ zohoTotal: 99.996, amount: 100 })).toBe("adopt");
  });

  it("flags a mismatch just past the tolerance boundary", () => {
    expect(classifyPendingClaim({ zohoTotal: 100.006, amount: 100 })).toBe("mismatch");
    expect(classifyPendingClaim({ zohoTotal: 99.99, amount: 100 })).toBe("mismatch");
  });

  it("flags clearly different totals in either direction", () => {
    // e.g. the crate minimum (£84) claimed but the orphan bills minimum +
    // handling (£156) — adopting would email the customer the wrong figure.
    expect(classifyPendingClaim({ zohoTotal: 156, amount: 84 })).toBe("mismatch");
    expect(classifyPendingClaim({ zohoTotal: 84, amount: 156 })).toBe("mismatch");
  });

  it("adopts when Zoho returned no usable total — nothing to verify against", () => {
    expect(classifyPendingClaim({ zohoTotal: undefined, amount: 100 })).toBe("adopt");
    expect(classifyPendingClaim({ zohoTotal: null, amount: 100 })).toBe("adopt");
    expect(classifyPendingClaim({ zohoTotal: Number.NaN, amount: 100 })).toBe("adopt");
  });
});
