import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOT_MAX_HOUR,
  DEFAULT_SLOT_MIN_HOUR,
  slotRangeFor,
} from "@/lib/schedule/slot-range";

/** ISO instants chosen so the UK-local hour differs from UTC in BST (Aug = +1). */
const at = (ukHour: number, ukMinute = 0) =>
  `2026-08-20T${String(ukHour - 1).padStart(2, "0")}:${String(ukMinute).padStart(2, "0")}:00Z`;

describe("slotRangeFor", () => {
  it("an ordinary working day keeps the comfortable default window", () => {
    expect(slotRangeFor([{ starts_at: at(9), ends_at: at(13) }])).toEqual({
      slotMinTime: `0${DEFAULT_SLOT_MIN_HOUR}:00:00`,
      slotMaxTime: `${DEFAULT_SLOT_MAX_HOUR}:00:00`,
    });
    expect(slotRangeFor([])).toEqual({ slotMinTime: "07:00:00", slotMaxTime: "20:00:00" });
  });

  it("QA-20260823-06: a 21:30 booking stretches the window instead of vanishing", () => {
    // The exact shape that found the bug — the booking dialog rounds its default
    // time up from "now", so an evening entry lands here without anyone choosing it.
    const { slotMinTime, slotMaxTime } = slotRangeFor([
      { starts_at: at(21, 30), ends_at: at(23, 0) },
    ]);
    expect(slotMinTime).toBe("07:00:00");
    expect(slotMaxTime).toBe("23:00:00");
  });

  it("an early start pulls the window down, a late finish pushes it up", () => {
    expect(slotRangeFor([{ starts_at: at(5, 30), ends_at: at(8) }]).slotMinTime).toBe("05:00:00");
    // 20:30 needs the 21:00 line drawn, or the tail of the job is clipped.
    expect(slotRangeFor([{ starts_at: at(18), ends_at: at(20, 30) }]).slotMaxTime).toBe("21:00:00");
  });

  it("reads hours in UK time, not UTC and not the runner's timezone", () => {
    // BST: 20:30Z is 21:30 in London, so the grid must reach 22:00. Reading the
    // instant as UTC would stop at 21:00 and clip the job — the original bug.
    expect(slotRangeFor([{ starts_at: "2026-08-20T20:30:00Z", ends_at: null }]).slotMaxTime).toBe(
      "22:00:00",
    );
    // GMT: the same clock reading in January IS 20:30 London, so it stops at
    // 21:00. The pair together prove the offset is applied seasonally, not blindly.
    expect(slotRangeFor([{ starts_at: "2026-01-20T20:30:00Z", ends_at: null }]).slotMaxTime).toBe(
      "21:00:00",
    );
  });

  it("all-day events never stretch the grid — they render in their own row", () => {
    expect(slotRangeFor([{ starts_at: at(23), ends_at: null, all_day: true }])).toEqual({
      slotMinTime: "07:00:00",
      slotMaxTime: "20:00:00",
    });
  });

  it("a job running past midnight shows the rest of its starting day", () => {
    expect(
      slotRangeFor([{ starts_at: at(22), ends_at: "2026-08-21T01:00:00Z" }]).slotMaxTime,
    ).toBe("24:00:00");
  });

  it("missing or unparseable times are skipped, never crash or widen", () => {
    expect(slotRangeFor([{ starts_at: "not-a-date", ends_at: null }])).toEqual({
      slotMinTime: "07:00:00",
      slotMaxTime: "20:00:00",
    });
    // A start with no end still needs its own hour drawn.
    expect(slotRangeFor([{ starts_at: at(22), ends_at: null }]).slotMaxTime).toBe("23:00:00");
  });

  it("the window is always a valid, non-empty range", () => {
    const r = slotRangeFor([{ starts_at: at(23, 45), ends_at: at(23, 50) }]);
    expect(r.slotMinTime < r.slotMaxTime).toBe(true);
    expect(r.slotMaxTime <= "24:00:00").toBe(true);
  });
});
