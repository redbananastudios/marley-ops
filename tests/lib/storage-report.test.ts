import { describe, expect, it } from "vitest";
import {
  buildStorageCostReport,
  buildStorageReport,
  letWeeks,
  weeklyRate,
  type CostReportLet,
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

  it("normalises daily (crate) rates to weekly (×7) — not treated as £/week", () => {
    expect(weeklyRate({ rate: 3, rate_period: "day" })).toBe(21);
    expect(weeklyRate({ rate: null, rate_period: "day" })).toBeNull();
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

  it("crate day-rate lets contribute their weekly-equivalent, not the day rate as £/week", () => {
    // One open crate at £3/day, started 28 days before TODAY (2026-06-12 → 2026-07-10).
    const lets = [let_({ id: "crate", unit_id: "u1", rate: 3, rate_period: "day", start_date: "2026-06-12" })];
    const r = buildStorageReport(sites, units, lets, TODAY);
    expect(r.recurring.perWeek).toBe(21); // £3/day → £21/week run-rate, not £3
    expect(r.avgWeeklyRate).toBe(21);
    expect(r.earnedToDate).toBe(84); // 4 weeks × £21, not letWeeks × £3
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

describe("buildStorageCostReport", () => {
  const supplier = { containerMonthCost: 174, containersCount: 2, crateDayCost: 2, handlingEventCost: 60 };
  const crate = (o: Partial<ReportLet>): CostReportLet => ({ ...let_(o), billing_model: "crate_daily" });
  const build = (over: Partial<Parameters<typeof buildStorageCostReport>[0]>) =>
    buildStorageCostReport({
      lets: [],
      events: [],
      units: [],
      supplier,
      monthStartIso: "2026-07-01",
      monthEndIso: "2026-07-31",
      ...over,
    });

  it("container rent is fixed — accrues with no lets at all", () => {
    const r = build({});
    expect(r.containersFixedCost).toBe(348); // 2 × £174, regardless of occupancy
    expect(r.crateDays).toBe(0);
    expect(r.handlingEvents).toBe(0);
    expect(r.totalCost).toBe(348);
    expect(r.containerUtilisationPct).toBeNull(); // no container units known
  });

  it("crate-day overlap clips each let to the month window (inclusive days)", () => {
    const days = (l: CostReportLet) => build({ lets: [l] }).crateDays;
    expect(days(crate({ start_date: "2026-05-01", end_date: null }))).toBe(31); // spans the whole month
    expect(days(crate({ start_date: "2026-06-15", end_date: "2026-07-10" }))).toBe(10); // ends mid-month
    expect(days(crate({ start_date: "2026-07-20", end_date: null }))).toBe(12); // starts mid-month, open
    expect(days(crate({ start_date: "2026-07-05", end_date: "2026-07-05" }))).toBe(1); // same-day let
    expect(days(crate({ start_date: "2026-06-01", end_date: "2026-06-30" }))).toBe(0); // ended before
    expect(days(crate({ start_date: "2026-08-03", end_date: null }))).toBe(0); // starts after
  });

  it("open crate lets accrue only to the cut-off, not to month end", () => {
    // Current month: the caller passes monthEndIso = today. 1st–10th = 10 days.
    const r = build({ lets: [crate({ start_date: "2026-07-01", end_date: null })], monthEndIso: "2026-07-10" });
    expect(r.crateDays).toBe(10);
    expect(r.crateDaysCost).toBe(20);
  });

  it("period lets never accrue crate days", () => {
    const lets: CostReportLet[] = [
      { ...let_({ start_date: "2026-07-01" }), billing_model: "period" },
      let_({ start_date: "2026-07-01" }), // billing_model absent (pre-v2 rows)
    ];
    expect(build({ lets }).crateDays).toBe(0);
  });

  it("handling events count inside the month boundaries, at the supplier rate", () => {
    const r = build({
      events: [
        { event_date: "2026-06-30" }, // day before — out
        { event_date: "2026-07-01" }, // first day — in
        { event_date: "2026-07-31" }, // last day — in
        { event_date: "2026-08-01" }, // day after — out
      ],
    });
    expect(r.handlingEvents).toBe(2);
    expect(r.handlingCost).toBe(120); // 2 × £60 supplier cost, NOT the customer amount
  });

  it("sums the three cost lines and rounds to 2dp", () => {
    const r = build({
      lets: [crate({ start_date: "2026-07-01", end_date: "2026-07-03" })], // 3 days
      events: [{ event_date: "2026-07-02" }],
      supplier: { ...supplier, crateDayCost: 1.7143 },
    });
    expect(r.crateDaysCost).toBe(5.14); // 3 × 1.7143 = 5.1429 → 5.14
    expect(r.totalCost).toBe(413.14); // 348 + 5.14 + 60
  });

  it("container utilisation counts occupied of ACTIVE container units only", () => {
    const units = [
      unit({ id: "c1", unit_type: "container_20ft" }),
      unit({ id: "c2", unit_type: "container_40ft" }),
      unit({ id: "c3", unit_type: "container_20ft", is_active: false }), // archived — excluded
      unit({ id: "k1", unit_type: "crate_250" }), // not a container
    ];
    const lets = [
      let_({ id: "a", unit_id: "c1" }), // open → c1 occupied
      let_({ id: "b", unit_id: "c2", start_date: "2026-05-01", end_date: "2026-06-01" }), // ended
      let_({ id: "c", unit_id: "k1" }), // crate occupancy doesn't count
    ];
    expect(build({ units, lets }).containerUtilisationPct).toBe(50);
    expect(build({ units: [unit({ id: "k1" })], lets }).containerUtilisationPct).toBeNull();
  });
});
