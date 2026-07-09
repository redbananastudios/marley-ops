import { describe, expect, it } from "vitest";
import { docStatus, vehicleNeedsAttention } from "@/lib/vehicles";

// Fixed "today" — 9 July 2026 (UK summer, UTC+1; helper works on calendar days).
const TODAY = new Date("2026-07-09T12:00:00Z");

describe("docStatus", () => {
  it("is none when unset or invalid", () => {
    expect(docStatus(null, TODAY).state).toBe("none");
    expect(docStatus("", TODAY).state).toBe("none");
    expect(docStatus("not-a-date", TODAY).state).toBe("none");
  });

  it("is overdue past the date, with negative days", () => {
    const s = docStatus("2026-07-01", TODAY);
    expect(s.state).toBe("overdue");
    expect(s.days).toBe(-8);
  });

  it("is due today and at the 30-day boundary", () => {
    expect(docStatus("2026-07-09", TODAY)).toEqual({ state: "due", days: 0 });
    expect(docStatus("2026-08-08", TODAY)).toEqual({ state: "due", days: 30 });
  });

  it("is ok beyond the warning window", () => {
    expect(docStatus("2026-08-09", TODAY)).toEqual({ state: "ok", days: 31 });
    expect(docStatus("2027-01-01", TODAY).state).toBe("ok");
  });

  it("accepts full timestamps by using the date part", () => {
    expect(docStatus("2026-07-01T09:30:00Z", TODAY).state).toBe("overdue");
  });
});

describe("vehicleNeedsAttention", () => {
  const base = { tax_due: null, mot_due: null, insurance_renewal: null };

  it("false with no dates set", () => {
    expect(vehicleNeedsAttention(base, TODAY)).toBe(false);
  });

  it("false when everything is comfortably in date", () => {
    expect(
      vehicleNeedsAttention(
        { tax_due: "2027-01-01", mot_due: "2026-12-01", insurance_renewal: "2026-09-01" },
        TODAY,
      ),
    ).toBe(false);
  });

  it("true when any one doc is due or overdue", () => {
    expect(vehicleNeedsAttention({ ...base, mot_due: "2026-07-20" }, TODAY)).toBe(true);
    expect(vehicleNeedsAttention({ ...base, tax_due: "2026-06-01" }, TODAY)).toBe(true);
  });
});
