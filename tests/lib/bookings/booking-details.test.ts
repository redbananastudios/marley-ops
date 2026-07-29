import { describe, expect, it } from "vitest";
import {
  cleanApproxWindow,
  normaliseApproxMonth,
  normaliseProvisionalDate,
  normalisePropertyType,
} from "@/lib/bookings/booking-details";

describe("cleanApproxWindow", () => {
  it("trims, keeps the customer's words, and treats empty as null", () => {
    expect(cleanApproxWindow("  mid-August  ")).toBe("mid-August");
    expect(cleanApproxWindow("")).toBeNull();
    expect(cleanApproxWindow("   ")).toBeNull();
    expect(cleanApproxWindow(null)).toBeNull();
    expect(cleanApproxWindow(undefined)).toBeNull();
  });

  it("caps the label at 120 characters", () => {
    const long = "a".repeat(300);
    expect(cleanApproxWindow(long)).toHaveLength(120);
  });
});

describe("normaliseApproxMonth", () => {
  it("turns a month-input value into a first-of-month date", () => {
    expect(normaliseApproxMonth("2026-08")).toEqual({ ok: true, value: "2026-08-01" });
  });

  it("accepts a stored first-of-month date unchanged (round-trip safe)", () => {
    expect(normaliseApproxMonth("2026-08-01")).toEqual({ ok: true, value: "2026-08-01" });
    // Any day component collapses to the 1st — the column is a grouping key.
    expect(normaliseApproxMonth("2026-08-15")).toEqual({ ok: true, value: "2026-08-01" });
  });

  it("treats empty as no target month, and rejects garbage or impossible months", () => {
    expect(normaliseApproxMonth("")).toEqual({ ok: true, value: null });
    expect(normaliseApproxMonth(null)).toEqual({ ok: true, value: null });
    expect(normaliseApproxMonth("August").ok).toBe(false);
    expect(normaliseApproxMonth("2026-13").ok).toBe(false);
    expect(normaliseApproxMonth("2026-00").ok).toBe(false);
  });
});

describe("normaliseProvisionalDate", () => {
  const TODAY = "2026-07-29";

  it("accepts a real calendar date and treats empty as unset", () => {
    expect(normaliseProvisionalDate("2026-08-14", TODAY)).toEqual({ ok: true, value: "2026-08-14" });
    expect(normaliseProvisionalDate("", TODAY)).toEqual({ ok: true, value: null });
    expect(normaliseProvisionalDate(undefined, TODAY)).toEqual({ ok: true, value: null });
  });

  it("rejects wrong shapes and dates that do not exist", () => {
    expect(normaliseProvisionalDate("14/08/2026", TODAY).ok).toBe(false);
    expect(normaliseProvisionalDate("2026-08", TODAY).ok).toBe(false);
    expect(normaliseProvisionalDate("2026-02-30", TODAY).ok).toBe(false);
  });

  it("bounds the date to today .. +2 years (a past date silently vanishes from the panel; a typo'd year pollutes grouping)", () => {
    expect(normaliseProvisionalDate("2026-07-28", TODAY).ok).toBe(false); // yesterday
    expect(normaliseProvisionalDate(TODAY, TODAY)).toEqual({ ok: true, value: TODAY }); // today OK
    expect(normaliseProvisionalDate("2028-07-29", TODAY)).toEqual({ ok: true, value: "2028-07-29" }); // +2y edge OK
    expect(normaliseProvisionalDate("2028-07-30", TODAY).ok).toBe(false); // beyond +2y
    expect(normaliseProvisionalDate("9999-12-31", TODAY).ok).toBe(false);
  });
});

describe("normalisePropertyType", () => {
  it("keeps the two known flags and reads anything else as unset", () => {
    expect(normalisePropertyType("homeowner")).toBe("homeowner");
    expect(normalisePropertyType("rented")).toBe("rented");
    expect(normalisePropertyType("")).toBeNull();
    expect(normalisePropertyType("mansion")).toBeNull();
    expect(normalisePropertyType(null)).toBeNull();
  });
});
