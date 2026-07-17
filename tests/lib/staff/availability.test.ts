import { describe, expect, it } from "vitest";
import {
  defaultWorkingDay,
  effectiveStatus,
  isWeekend,
  staffOffOn,
  type AvailabilityRow,
} from "@/lib/staff/availability";

// Fixed reference days (UK): 20 Jul 2026 = Mon, 24 Jul = Fri, 18 Jul = Sat, 19 Jul = Sun.
const MON = "2026-07-20";
const FRI = "2026-07-24";
const SAT = "2026-07-18";
const SUN = "2026-07-19";

const row = (date: string, status: "available" | "unavailable", note?: string): AvailabilityRow => ({
  date,
  status,
  note: note ?? null,
});

describe("defaultWorkingDay", () => {
  it("is true Mon–Fri", () => {
    expect(defaultWorkingDay(MON)).toBe(true);
    expect(defaultWorkingDay(FRI)).toBe(true);
  });
  it("is false at the weekend", () => {
    expect(defaultWorkingDay(SAT)).toBe(false);
    expect(defaultWorkingDay(SUN)).toBe(false);
  });
  it("ignores a time suffix on the date", () => {
    expect(defaultWorkingDay("2026-07-20T09:30:00Z")).toBe(true);
  });
});

describe("isWeekend", () => {
  it("flags Sat and Sun only", () => {
    expect(isWeekend(SAT)).toBe(true);
    expect(isWeekend(SUN)).toBe(true);
    expect(isWeekend(MON)).toBe(false);
    expect(isWeekend(FRI)).toBe(false);
  });
});

describe("effectiveStatus", () => {
  it("defaults a bare weekday to available", () => {
    expect(effectiveStatus([], MON)).toBe("available");
  });
  it("defaults a bare weekend to unavailable", () => {
    expect(effectiveStatus([], SAT)).toBe("unavailable");
  });
  it("an explicit row overrides the default in both directions", () => {
    expect(effectiveStatus([row(MON, "unavailable")], MON)).toBe("unavailable"); // weekday off
    expect(effectiveStatus([row(SAT, "available")], SAT)).toBe("available"); // weekend offered
  });
  it("matches the row ignoring a time suffix and unrelated rows", () => {
    const rows = [row(FRI, "unavailable"), row("2026-07-20T00:00:00", "unavailable")];
    expect(effectiveStatus(rows, MON)).toBe("unavailable");
    expect(effectiveStatus(rows, "2026-07-27")).toBe("available"); // a different Monday, no row
  });
});

describe("staffOffOn", () => {
  it("a normal weekday with no row is not off", () => {
    expect(staffOffOn([], MON)).toEqual({ off: false, reason: null });
  });
  it("a bare weekend is off, reason Weekend", () => {
    expect(staffOffOn([], SAT)).toEqual({ off: true, reason: "Weekend" });
  });
  it("a weekday booked off is off, reason Off when no note", () => {
    expect(staffOffOn([row(MON, "unavailable")], MON)).toEqual({ off: true, reason: "Off" });
  });
  it("uses the note as the reason when present", () => {
    expect(staffOffOn([row(MON, "unavailable", "Holiday")], MON)).toEqual({ off: true, reason: "Holiday" });
  });
  it("a blank/whitespace note falls back to Off", () => {
    expect(staffOffOn([row(MON, "unavailable", "   ")], MON)).toEqual({ off: true, reason: "Off" });
  });
  it("a weekend explicitly offered is not off", () => {
    expect(staffOffOn([row(SAT, "available")], SAT)).toEqual({ off: false, reason: null });
  });
});
