import { describe, expect, it } from "vitest";
import {
  defaultWorkingDay,
  effectiveStatus,
  groupAvailabilityRuns,
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

describe("groupAvailabilityRuns", () => {
  const r = (id: string, date: string, status: "available" | "unavailable", note: string | null = null) => ({
    id,
    date,
    status,
    note,
  });

  it("merges a contiguous same-status run into one segment", () => {
    const segs = groupAvailabilityRuns([
      r("a", "2026-07-20", "unavailable", "Holiday"),
      r("b", "2026-07-21", "unavailable", "Holiday"),
      r("c", "2026-07-22", "unavailable", "Holiday"),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ start: "2026-07-20", end: "2026-07-22", status: "unavailable", note: "Holiday" });
    expect(segs[0].ids).toEqual(["a", "b", "c"]);
  });

  it("splits on a gap, a status change, or a note change", () => {
    const segs = groupAvailabilityRuns([
      r("a", "2026-07-20", "unavailable"),
      r("b", "2026-07-22", "unavailable"), // gap (skips 21st)
      r("c", "2026-07-23", "available"), // status change
      r("d", "2026-07-24", "available", "AM only"), // note change
    ]);
    expect(segs.map((s) => `${s.start}..${s.end}:${s.status}`)).toEqual([
      "2026-07-20..2026-07-20:unavailable",
      "2026-07-22..2026-07-22:unavailable",
      "2026-07-23..2026-07-23:available",
      "2026-07-24..2026-07-24:available",
    ]);
  });

  it("sorts unordered rows before grouping and spans a month boundary", () => {
    const segs = groupAvailabilityRuns([
      r("b", "2026-08-01", "unavailable"),
      r("a", "2026-07-31", "unavailable"),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ start: "2026-07-31", end: "2026-08-01" });
    expect(segs[0].ids).toEqual(["a", "b"]);
  });

  it("returns nothing for no rows", () => {
    expect(groupAvailabilityRuns([])).toEqual([]);
  });
});
