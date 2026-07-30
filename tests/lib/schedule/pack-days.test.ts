import { describe, expect, it } from "vitest";
import { dayDelta, defaultPackDay, packRequirement, shiftIsoByUkDays } from "@/lib/schedule/pack-days";

describe("dayDelta", () => {
  it("counts whole days either direction", () => {
    expect(dayDelta("2026-08-10", "2026-08-14")).toBe(4);
    expect(dayDelta("2026-08-14", "2026-08-10")).toBe(-4);
    expect(dayDelta("2026-08-10", "2026-08-10")).toBe(0);
  });
});

describe("shiftIsoByUkDays", () => {
  it("keeps the UK wall-clock time when shifting", () => {
    // 09:00 BST on 10 Aug = 08:00Z; +4 days must stay 09:00 UK (08:00Z).
    expect(shiftIsoByUkDays("2026-08-10T08:00:00.000Z", 4)).toBe("2026-08-14T08:00:00.000Z");
  });

  it("stays 09:00 UK across the October DST boundary (raw ms maths would drift an hour)", () => {
    // 09:00 BST on 23 Oct = 08:00Z. Clocks fall back on 25 Oct; +5 days must be
    // 09:00 GMT on 28 Oct = 09:00Z (NOT 08:00Z).
    expect(shiftIsoByUkDays("2026-10-23T08:00:00.000Z", 5)).toBe("2026-10-28T09:00:00.000Z");
  });
});

describe("packRequirement", () => {
  it("demands at least one person and never a van; demand follows the allocation", () => {
    expect(packRequirement(0)).toEqual({ vans: 0, men: 1 });
    expect(packRequirement(1)).toEqual({ vans: 0, men: 1 });
    expect(packRequirement(3)).toEqual({ vans: 0, men: 3 });
  });
});

describe("defaultPackDay", () => {
  it("is the day before the move, across month boundaries", () => {
    expect(defaultPackDay("2026-08-14")).toBe("2026-08-13");
    expect(defaultPackDay("2026-09-01")).toBe("2026-08-31");
  });
});
