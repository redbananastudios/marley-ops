import { describe, expect, it } from "vitest";
import {
  buildStorageReport,
  letWeeks,
  weeklyRate,
  type ReportLet,
  type ReportUnit,
} from "@/lib/storage-report";

const TODAY = "2026-07-10";

const unit = (o: Partial<ReportUnit>): ReportUnit => ({
  id: o.id ?? "u",
  site_id: "s1",
  unit_type: "crate_250",
  is_active: true,
  ...o,
});

const let_ = (o: Partial<ReportLet>): ReportLet => ({
  id: o.id ?? "l",
  unit_id: "u1",
  client_id: "c1",
  start_date: "2026-07-01",
  end_date: null,
  rate: 25,
  rate_period: "week",
  ...o,
});

describe("letWeeks", () => {
  it("bills the first week from day one and rounds up part-weeks", () => {
    expect(letWeeks("2026-07-10", "2026-07-10")).toBe(1); // starts today
    expect(letWeeks("2026-07-01", "2026-07-08")).toBe(1); // exactly 7 days
    expect(letWeeks("2026-07-01", "2026-07-09")).toBe(2); // 8 days → 2nd week begun
    expect(letWeeks("2026-05-01", "2026-07-10")).toBe(10); // 70 days
  });
});

describe("weeklyRate", () => {
  it("normalises monthly rates to weekly (×12/52)", () => {
    expect(weeklyRate({ rate: 26, rate_period: "week" })).toBe(26);
    expect(weeklyRate({ rate: 130, rate_period: "month" })).toBeCloseTo(30, 5);
    expect(weeklyRate({ rate: null, rate_period: "week" })).toBeNull();
  });
});

describe("buildStorageReport", () => {
  const sites = [
    { id: "s1", is_active: true },
    { id: "s2", is_active: false },
  ];
  const units = [
    unit({ id: "u1" }),
    unit({ id: "u2", unit_type: "container_20ft" }),
    unit({ id: "u3", unit_type: "container_20ft" }),
    unit({ id: "u4", is_active: false }), // archived — never counted
  ];

  it("occupancy counts active units against open lets", () => {
    const r = buildStorageReport(sites, units, [let_({ unit_id: "u1" }), let_({ id: "l2", unit_id: "u2", client_id: "c2" })], TODAY);
    expect(r.sites).toBe(1);
    expect(r.units).toEqual({ total: 3, occupied: 2, available: 1, occupancyPct: 67 });
    expect(r.byType).toEqual([
      { type: "container_20ft", total: 2, occupied: 1 },
      { type: "crate_250", total: 1, occupied: 1 },
    ]);
  });

  it("customers split into current and former (a returning client is only current)", () => {
    const lets = [
      let_({ id: "a", client_id: "cur", unit_id: "u1" }),
      let_({ id: "b", client_id: "cur", unit_id: "u2", end_date: "2026-06-01", start_date: "2026-05-01" }),
      let_({ id: "c", client_id: "old", unit_id: "u3", end_date: "2026-03-01", start_date: "2026-02-01" }),
    ];
    const r = buildStorageReport(sites, units, lets, TODAY);
    expect(r.customers).toEqual({ current: 1, former: 1 });
  });

  it("recurring run-rate sums open lets both ways and flags unpriced ones", () => {
    const lets = [
      let_({ id: "a", unit_id: "u1", rate: 25, rate_period: "week" }),
      let_({ id: "b", unit_id: "u2", rate: 130, rate_period: "month" }), // £30/wk
      let_({ id: "c", unit_id: "u3", rate: null }),
      let_({ id: "d", unit_id: "u1", end_date: "2026-06-01", start_date: "2026-05-01", rate: 99 }), // ended — excluded
    ];
    const r = buildStorageReport(sites, units, lets, TODAY);
    expect(r.recurring.perWeek).toBe(55);
    expect(r.recurring.perMonth).toBeCloseTo(238.33, 2);
    expect(r.recurring.pricedLets).toBe(2);
    expect(r.recurring.unpricedLets).toBe(1);
    expect(r.avgWeeklyRate).toBe(27.5);
  });

  it("earned-to-date covers open lets up to today and ended lets to their end", () => {
    const lets = [
      let_({ id: "a", start_date: "2026-06-26", rate: 25 }), // 14 days to today = 2 weeks → £50
      let_({ id: "b", unit_id: "u2", start_date: "2026-05-01", end_date: "2026-05-29", rate: 10 }), // 28 days = 4 weeks → £40
    ];
    const r = buildStorageReport(sites, units, lets, TODAY);
    expect(r.earnedToDate).toBe(90);
  });

  it("durations: avg of completed lets, longest still running", () => {
    const lets = [
      let_({ id: "a", start_date: "2026-04-17", end_date: "2026-05-29" }), // 6 weeks
      let_({ id: "b", start_date: "2026-06-05", end_date: "2026-06-19" }), // 2 weeks
      let_({ id: "c", unit_id: "u2", start_date: "2026-05-15" }), // open, 8 weeks to today
    ];
    const r = buildStorageReport(sites, units, lets, TODAY);
    expect(r.avgLetWeeks).toBe(4);
    expect(r.longestOpenWeeks).toBe(8);
  });

  it("empty storage returns nulls, not divide-by-zero", () => {
    const r = buildStorageReport([], [], [], TODAY);
    expect(r.units.occupancyPct).toBeNull();
    expect(r.avgWeeklyRate).toBeNull();
    expect(r.avgLetWeeks).toBeNull();
    expect(r.longestOpenWeeks).toBeNull();
    expect(r.earnedToDate).toBe(0);
  });
});
