import { describe, it, expect } from "vitest";
import { SNOOZE_OPTIONS, snoozeByDays, snoozeByMonth, snoozeUntil } from "@/lib/follow-ups/snooze";

// Local time is what the UI works in; construct with the local constructor so
// these assertions hold wherever they run.
const at = (y: number, m: number, d: number, h = 14, min = 30) => new Date(y, m - 1, d, h, min);

describe("snoozeByDays", () => {
  it("moves the date and pins the time to 09:00", () => {
    const r = snoozeByDays(1, at(2026, 8, 10));
    expect(r.getDate()).toBe(11);
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(0);
  });

  it("handles a fortnight across a month end", () => {
    const r = snoozeByDays(14, at(2026, 8, 25));
    expect([r.getMonth() + 1, r.getDate()]).toEqual([9, 8]);
  });
});

describe("snoozeByMonth", () => {
  it("lands on the same day next month", () => {
    const r = snoozeByMonth(at(2026, 8, 10));
    expect([r.getFullYear(), r.getMonth() + 1, r.getDate()]).toEqual([2026, 9, 10]);
    expect(r.getHours()).toBe(9);
  });

  it("clamps to the last day when the target month is shorter", () => {
    // The trap: setMonth() on 31 Jan rolls FORWARD to 3 March, quietly snoozing
    // five weeks instead of four.
    const r = snoozeByMonth(at(2026, 1, 31));
    expect([r.getMonth() + 1, r.getDate()]).toEqual([2, 28]);
  });

  it("clamps to 29 Feb in a leap year", () => {
    const r = snoozeByMonth(at(2028, 1, 31));
    expect([r.getMonth() + 1, r.getDate()]).toEqual([2, 29]);
  });

  it("rolls the year over from December", () => {
    const r = snoozeByMonth(at(2026, 12, 15));
    expect([r.getFullYear(), r.getMonth() + 1, r.getDate()]).toEqual([2027, 1, 15]);
  });

  it("handles 30-day months landing on a 31-day one", () => {
    const r = snoozeByMonth(at(2026, 4, 30));
    expect([r.getMonth() + 1, r.getDate()]).toEqual([5, 30]);
  });
});

describe("SNOOZE_OPTIONS", () => {
  it("offers the five durations the office asked for", () => {
    expect(SNOOZE_OPTIONS.map((o) => o.label)).toEqual([
      "Tomorrow",
      "In 3 days",
      "In a week",
      "In a fortnight",
      "In a month",
    ]);
  });

  it("every option resolves to a real future 09:00", () => {
    const from = at(2026, 8, 10);
    for (const o of SNOOZE_OPTIONS) {
      const d = new Date(snoozeUntil(o.value, from));
      expect(Number.isNaN(d.getTime())).toBe(false);
      expect(d.getTime()).toBeGreaterThan(from.getTime());
      expect(d.getHours()).toBe(9);
    }
  });

  it("orders the options from soonest to furthest", () => {
    const from = at(2026, 8, 10);
    const times = SNOOZE_OPTIONS.map((o) => new Date(snoozeUntil(o.value, from)).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
