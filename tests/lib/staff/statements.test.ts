import { describe, expect, it } from "vitest";
import {
  computeLineAmount,
  periodLabel,
  previousWeekPeriod,
  round2,
  seedLinesFromDays,
  statementTotal,
  weekPeriodOf,
} from "@/lib/staff/statements";

describe("computeLineAmount", () => {
  it("multiplies quantity by rate when both are present", () => {
    expect(computeLineAmount(2, 120, null)).toBe(240);
    expect(computeLineAmount(1.5, 100, 999)).toBe(150); // qty×rate wins over any stored amount
  });
  it("falls back to the entered amount when qty or rate is missing", () => {
    expect(computeLineAmount(null, null, 150)).toBe(150);
    expect(computeLineAmount(1, null, 100)).toBe(100); // rate missing → use amount
    expect(computeLineAmount(null, 120, 80)).toBe(80); // qty missing → use amount
  });
  it("never goes negative and rounds to pennies", () => {
    expect(computeLineAmount(null, null, -5)).toBe(0);
    expect(computeLineAmount(3, 33.333, null)).toBe(100); // 99.999 → 100.00
  });
});

describe("statementTotal", () => {
  it("sums line amounts to the penny", () => {
    expect(statementTotal([{ amount: 240 }, { amount: 150 }, { amount: null }])).toBe(390);
    expect(statementTotal([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
  });
  it("is zero for no lines", () => {
    expect(statementTotal([])).toBe(0);
  });
});

describe("round2", () => {
  it("rounds half up to two decimals", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(2.005)).toBe(2.01);
  });
});

describe("pay periods", () => {
  const WED = "2026-07-22"; // Wednesday
  it("weekPeriodOf returns the Mon–Sun week containing the date", () => {
    expect(weekPeriodOf(WED)).toEqual({ start: "2026-07-20", end: "2026-07-26" });
  });
  it("weekPeriodOf on a Monday and Sunday stay in the same week", () => {
    expect(weekPeriodOf("2026-07-20")).toEqual({ start: "2026-07-20", end: "2026-07-26" });
    expect(weekPeriodOf("2026-07-26")).toEqual({ start: "2026-07-20", end: "2026-07-26" });
  });
  it("previousWeekPeriod returns the week just finished", () => {
    expect(previousWeekPeriod(WED)).toEqual({ start: "2026-07-13", end: "2026-07-19" });
  });
});

describe("periodLabel", () => {
  it("labels a same-month week compactly", () => {
    expect(periodLabel("2026-07-20", "2026-07-26")).toBe("20–26 Jul");
  });
  it("spans a month boundary", () => {
    expect(periodLabel("2026-07-28", "2026-08-03")).toBe("28 Jul – 3 Aug");
  });
  it("collapses a single day", () => {
    expect(periodLabel("2026-07-20", "2026-07-20")).toBe("20 Jul");
  });
});

describe("seedLinesFromDays", () => {
  it("makes one deduped, date-sorted line per day at the day rate", () => {
    const lines = seedLinesFromDays(
      [
        { date: "2026-07-22", label: "Move — Smith" },
        { date: "2026-07-20" },
        { date: "2026-07-20" }, // duplicate day collapses
      ],
      120,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ work_date: "2026-07-20", amount: 120, source: "job", description: "Worked Mon 20 Jul" });
    expect(lines[1].description).toBe("Worked Wed 22 Jul — Move — Smith");
  });
  it("uses 0 when no day rate is set (crew fill it in)", () => {
    const lines = seedLinesFromDays([{ date: "2026-07-20" }], null);
    expect(lines[0]).toMatchObject({ amount: 0, unit_amount: null });
  });
});
