import { describe, expect, it } from "vitest";
import {
  crateInvoicesDue,
  crateNextInvoiceDate,
  invoicesDue,
  MAX_PERIODS_PER_RUN,
  nextInvoiceDate,
  nextPeriodStart,
  periodEnd,
  periodsDue,
  storageInvoiceReference,
  type BillableLet,
  type HandlingEventLite,
} from "@/lib/storage-billing";

const weekly = (over: Partial<BillableLet> = {}): BillableLet => ({
  id: "11111111-2222-4333-8444-555555555555",
  start_date: "2026-07-01",
  end_date: null,
  rate: 25,
  rate_period: "week",
  billing_paused: false,
  ...over,
});

describe("nextPeriodStart / periodEnd", () => {
  it("weekly advances 7 days; period end is the day before the next start", () => {
    expect(nextPeriodStart("2026-07-01", "2026-07-01", "week")).toBe("2026-07-08");
    expect(periodEnd("2026-07-01", "2026-07-01", "week")).toBe("2026-07-07");
  });

  it("monthly stays on the anniversary day", () => {
    expect(nextPeriodStart("2026-07-15", "2026-07-15", "month")).toBe("2026-08-15");
    expect(periodEnd("2026-07-15", "2026-07-15", "month")).toBe("2026-08-14");
  });

  it("monthly clamps short months and RECOVERS to the anchor day after them", () => {
    // Anchor on the 31st: Aug 31 → Sep 30 (clamped) → Oct 31 (recovered).
    expect(nextPeriodStart("2026-08-31", "2026-08-31", "month")).toBe("2026-09-30");
    expect(nextPeriodStart("2026-09-30", "2026-08-31", "month")).toBe("2026-10-31");
    // January 31 anchor across February (2027 not a leap year).
    expect(nextPeriodStart("2027-01-31", "2027-01-31", "month")).toBe("2027-02-28");
    expect(nextPeriodStart("2027-02-28", "2027-01-31", "month")).toBe("2027-03-31");
  });
});

describe("periodsDue", () => {
  it("bills in advance: the period starting today is due, tomorrow's is not", () => {
    const due = periodsDue(weekly(), new Set(), "2026-07-01");
    expect(due).toEqual([{ period_start: "2026-07-01", period_end: "2026-07-07", amount: 25 }]);
  });

  it("backfills missed periods and skips already-invoiced ones", () => {
    const due = periodsDue(weekly(), new Set(["2026-07-08"]), "2026-07-16");
    expect(due.map((p) => p.period_start)).toEqual(["2026-07-01", "2026-07-15"]);
  });

  it("NO pro-rata: the period containing end_date bills in full; later ones never do", () => {
    const due = periodsDue(weekly({ end_date: "2026-07-10" }), new Set(), "2026-08-01");
    // 01 Jul (full) + 08 Jul (contains the 10 Jul end, full) — nothing after.
    expect(due.map((p) => p.period_start)).toEqual(["2026-07-01", "2026-07-08"]);
    expect(due[1].period_end).toBe("2026-07-14");
  });

  it("paused or unpriced lets never bill", () => {
    expect(periodsDue(weekly({ billing_paused: true }), new Set(), "2026-07-20")).toEqual([]);
    expect(periodsDue(weekly({ rate: null }), new Set(), "2026-07-20")).toEqual([]);
    expect(periodsDue(weekly({ rate: 0 }), new Set(), "2026-07-20")).toEqual([]);
  });

  it("caps runaway backfill at MAX_PERIODS_PER_RUN", () => {
    const due = periodsDue(weekly({ start_date: "2025-01-01" }), new Set(), "2026-07-01");
    expect(due).toHaveLength(MAX_PERIODS_PER_RUN);
  });

  it("monthly amounts and bounds follow the anchor", () => {
    const due = periodsDue(
      weekly({ start_date: "2026-05-31", rate: 120, rate_period: "month" }),
      new Set(),
      "2026-07-01",
    );
    expect(due).toEqual([
      { period_start: "2026-05-31", period_end: "2026-06-29", amount: 120 },
      { period_start: "2026-06-30", period_end: "2026-07-30", amount: 120 },
    ]);
  });
});

describe("nextInvoiceDate", () => {
  it("names the first future period once current ones are invoiced", () => {
    expect(nextInvoiceDate(weekly(), new Set(["2026-07-01"]), "2026-07-01")).toBe("2026-07-08");
  });
  it("names an overdue-to-raise period so the UI can flag catch-up", () => {
    expect(nextInvoiceDate(weekly(), new Set(), "2026-07-02")).toBe("2026-07-01");
  });
  it("null for ended, paused or unpriced lets", () => {
    expect(nextInvoiceDate(weekly({ end_date: "2026-07-05" }), new Set(), "2026-07-02")).toBeNull();
    expect(nextInvoiceDate(weekly({ billing_paused: true }), new Set(), "2026-07-02")).toBeNull();
    expect(nextInvoiceDate(weekly({ rate: null }), new Set(), "2026-07-02")).toBeNull();
  });
});

describe("buildStorageBillingStats", () => {
  it("splits billed/paid/outstanding and flags stale unpaid periods as overdue", async () => {
    const { buildStorageBillingStats } = await import("@/lib/storage-report");
    const stats = buildStorageBillingStats(
      [
        { amount: 25, status: "paid", period_start: "2026-06-01" },
        { amount: 25, status: "sent", period_start: "2026-06-08" }, // >14d old → overdue
        { amount: 25, status: "sent", period_start: "2026-07-08" }, // recent → just outstanding
        { amount: 25, status: "void", period_start: "2026-06-15" }, // excluded entirely
        { amount: 25, status: "error", period_start: "2026-06-22" }, // excluded entirely
      ],
      "2026-07-10",
    );
    expect(stats).toEqual({
      billed: 75,
      paid: 25,
      outstanding: 50,
      invoiceCount: 3,
      paidCount: 1,
      outstandingCount: 2,
      overdueCount: 1,
    });
  });

  it("a named brand slices to that brand's invoices; combined = sum of slices (multi-brand PRD §4)", async () => {
    const { buildStorageBillingStats } = await import("@/lib/storage-report");
    const invoices = [
      { amount: 25, status: "paid", period_start: "2026-06-01", brand: "marley" },
      { amount: 10, status: "sent", period_start: "2026-06-08", brand: "marley" }, // >14d → overdue
      { amount: 40, status: "sent", period_start: "2026-07-08", brand: "pitmans" },
    ];
    const all = buildStorageBillingStats(invoices, "2026-07-10");
    const m = buildStorageBillingStats(invoices, "2026-07-10", "marley");
    const p = buildStorageBillingStats(invoices, "2026-07-10", "pitmans");
    expect(all).toEqual(buildStorageBillingStats(invoices, "2026-07-10", "all"));
    expect(m).toEqual({
      billed: 35,
      paid: 25,
      outstanding: 10,
      invoiceCount: 2,
      paidCount: 1,
      outstandingCount: 1,
      overdueCount: 1,
    });
    expect(p.billed).toBe(40);
    expect(all.billed).toBe(m.billed + p.billed);
    expect(all.overdueCount).toBe(m.overdueCount + p.overdueCount);
  });
});

describe("storageInvoiceReference", () => {
  it("is stable per let+period (the Zoho adoption key)", () => {
    expect(storageInvoiceReference("11111111-2222-4333-8444-555555555555", "2026-07-01")).toBe(
      "MMS-11111111-2026-07-01",
    );
  });
});

/* ------------------------------------------------------------- crate_daily */

// Start 1 Jul: minimum covers 1-28 Jul; cycle 1 = 29 Jul-25 Aug (raise 26 Aug);
// cycle 2 = 26 Aug-22 Sep (raise 23 Sep).
const crate = (over: Partial<BillableLet> = {}): BillableLet => ({
  id: "aaaaaaaa-2222-4333-8444-555555555555",
  start_date: "2026-07-01",
  end_date: null,
  rate: 3,
  rate_period: "day",
  billing_paused: false,
  billing_model: "crate_daily",
  min_days: 28,
  min_amount: 84,
  ...over,
});

const ev = (over: Partial<HandlingEventLite> = {}): HandlingEventLite => ({
  id: "e1",
  event_date: "2026-07-01",
  kind: "in",
  amount: 72,
  ...over,
});

describe("crateInvoicesDue — the 28-day minimum", () => {
  it("is due in advance on the commencement day, in full", () => {
    const due = crateInvoicesDue(crate(), new Set(), [], "2026-07-01");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      period_start: "2026-07-01",
      period_end: "2026-07-28",
      kind: "minimum",
      usageAmount: 84,
      amount: 84,
      days: 28,
    });
  });

  it("is not due before the start day, and not re-raised once claimed", () => {
    expect(crateInvoicesDue(crate(), new Set(), [], "2026-06-30")).toHaveLength(0);
    expect(crateInvoicesDue(crate(), new Set(["2026-07-01"]), [], "2026-07-05")).toHaveLength(0);
  });

  it("still bills in full on an early release — 2 days of use pays the whole minimum", () => {
    const due = crateInvoicesDue(crate({ end_date: "2026-07-02" }), new Set(), [], "2026-07-02");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: "minimum", amount: 84, period_end: "2026-07-28" });
  });

  it("sweeps the ingress handling event onto the minimum invoice", () => {
    const due = crateInvoicesDue(crate(), new Set(), [ev()], "2026-07-01");
    expect(due[0]).toMatchObject({ amount: 156, usageAmount: 84, handlingAmount: 72 });
    expect(due[0].handlingEvents.map((e) => e.id)).toEqual(["e1"]);
  });

  it("nothing raises when paused or unpriced", () => {
    expect(crateInvoicesDue(crate({ billing_paused: true }), new Set(), [], "2026-08-30")).toHaveLength(0);
    expect(crateInvoicesDue(crate({ rate: 0 }), new Set(), [], "2026-08-30")).toHaveLength(0);
  });
});

describe("crateInvoicesDue — day 29+ in arrears on a 28-day cycle", () => {
  it("a cycle is NOT due while it is still running", () => {
    const due = crateInvoicesDue(crate(), new Set(["2026-07-01"]), [], "2026-08-25");
    expect(due).toHaveLength(0);
  });

  it("bills the day after the cycle completes, at days × day rate", () => {
    const due = crateInvoicesDue(crate(), new Set(["2026-07-01"]), [], "2026-08-26");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      period_start: "2026-07-29",
      period_end: "2026-08-25",
      kind: "arrears",
      amount: 84, // 28 days × £3
      days: 28,
    });
  });

  it("later cycles chain exactly 28 days apart", () => {
    const due = crateInvoicesDue(crate(), new Set(["2026-07-01", "2026-07-29"]), [], "2026-09-23");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ period_start: "2026-08-26", period_end: "2026-09-22", days: 28 });
  });

  it("a mid-cycle access event rides that cycle's invoice", () => {
    const access = ev({ id: "e2", event_date: "2026-08-05", kind: "access" });
    const due = crateInvoicesDue(crate(), new Set(["2026-07-01"]), [access], "2026-08-26");
    expect(due[0]).toMatchObject({ amount: 156, usageAmount: 84, handlingAmount: 72 });
  });

  it("an event recorded late (dated inside the already-billed minimum) rides the next invoice", () => {
    const late = ev({ id: "e3", event_date: "2026-07-10" });
    const due = crateInvoicesDue(crate(), new Set(["2026-07-01"]), [late], "2026-08-26");
    expect(due[0].handlingEvents.map((e) => e.id)).toEqual(["e3"]);
    expect(due[0].amount).toBe(156);
  });

  it("caps runaway backfill at MAX_PERIODS_PER_RUN", () => {
    const due = crateInvoicesDue(crate(), new Set(), [], "2030-01-01");
    expect(due).toHaveLength(MAX_PERIODS_PER_RUN);
  });
});

describe("crateInvoicesDue — release settlement", () => {
  it("a set end date makes the truncated remainder due IMMEDIATELY, charging the departure day", () => {
    // Released 10 Aug: final = 29 Jul-10 Aug inclusive = 13 days × £3 = £39.
    const due = crateInvoicesDue(crate({ end_date: "2026-08-10" }), new Set(["2026-07-01"]), [], "2026-08-10");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      period_start: "2026-07-29",
      period_end: "2026-08-10",
      kind: "final",
      amount: 39,
      days: 13,
    });
  });

  it("the egress event rides the final invoice", () => {
    const out = ev({ id: "e4", event_date: "2026-08-10", kind: "out" });
    const due = crateInvoicesDue(crate({ end_date: "2026-08-10" }), new Set(["2026-07-01"]), [out], "2026-08-10");
    expect(due[0]).toMatchObject({ amount: 111, usageAmount: 39, handlingAmount: 72 });
  });

  it("release inside the minimum window owes no day charges — a handling-only final carries the egress", () => {
    const out = ev({ id: "e5", event_date: "2026-07-15", kind: "out" });
    const due = crateInvoicesDue(crate({ end_date: "2026-07-15" }), new Set(["2026-07-01"]), [out], "2026-07-15");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      period_start: "2026-07-16", // claimed at end+1 — no cycle can ever start there
      kind: "final",
      usageAmount: 0,
      handlingAmount: 72,
      amount: 72,
      days: 0,
    });
  });

  it("release inside the minimum window with no unbilled events raises nothing further", () => {
    const due = crateInvoicesDue(crate({ end_date: "2026-07-15" }), new Set(["2026-07-01"]), [], "2026-07-15");
    expect(due).toHaveLength(0);
  });

  it("the handling-only settlement is never raised twice (end+1 claim honoured)", () => {
    const out = ev({ id: "e6", event_date: "2026-07-15", kind: "out" });
    const due = crateInvoicesDue(
      crate({ end_date: "2026-07-15" }),
      new Set(["2026-07-01", "2026-07-16"]),
      [out],
      "2026-07-16",
    );
    expect(due).toHaveLength(0);
  });

  it("same-day release: minimum bills with both handling events, nothing else", () => {
    const events = [ev({ id: "in1" }), ev({ id: "out1", event_date: "2026-07-01", kind: "out" })];
    const due = crateInvoicesDue(crate({ end_date: "2026-07-01" }), new Set(), events, "2026-07-01");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ kind: "minimum", amount: 84 + 144, handlingAmount: 144 });
  });

  it("no cycles ever start after departure", () => {
    // Released 30 Aug: cycle 1 (29 Jul-25 Aug) full, final 26-30 Aug (5 days), then nothing.
    const due = crateInvoicesDue(crate({ end_date: "2026-08-30" }), new Set(["2026-07-01"]), [], "2026-12-01");
    expect(due.map((d) => [d.period_start, d.period_end, d.kind, d.amount])).toEqual([
      ["2026-07-29", "2026-08-25", "arrears", 84],
      ["2026-08-26", "2026-08-30", "final", 15],
    ]);
  });
});

/* ---------------------------------- crate_daily — calendar-month minimum */

// storage-terms v2 (2026-08-31, commit 1038f96): "a minimum period of one
// calendar month", with to-the-day charging only AFTER that month ends.
// min_kind='calendar_month' lets derive the window from the SAME clamped
// month arithmetic the period engine uses (nextPeriodStart/periodEnd):
// 15 Sep → covered through 14 Oct; 31 Jan → through 27/28 Feb.
// min_kind absent or 'days' keeps the frozen min_days behaviour (v1 terms).
const cmCrate = (over: Partial<BillableLet> = {}): BillableLet =>
  crate({ start_date: "2026-09-15", min_kind: "calendar_month", ...over });

describe("crateInvoicesDue — calendar-month minimum (storage-terms v2)", () => {
  it("the minimum covers one calendar month: 15 Sep runs through 14 Oct (30 days), £84 flat", () => {
    const due = crateInvoicesDue(cmCrate(), new Set(), [], "2026-09-15");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      period_start: "2026-09-15",
      period_end: "2026-10-14",
      kind: "minimum",
      usageAmount: 84,
      amount: 84,
      days: 30,
    });
  });

  it("REGRESSION (#167 defect): days 29..month-end must NOT bill daily — nothing due 12-14 Oct", () => {
    // The 28-day grid would end the minimum on 12 Oct and bill 13-14 Oct to
    // the day. The signed terms cover through 14 Oct; the first arrears
    // cycle is 15 Oct-11 Nov, due 12 Nov — nothing may raise before that.
    for (const today of ["2026-10-12", "2026-10-13", "2026-10-14", "2026-11-11"]) {
      expect(crateInvoicesDue(cmCrate(), new Set(["2026-09-15"]), [], today)).toHaveLength(0);
    }
  });

  it("arrears start the day after the calendar month ends: 15 Oct-11 Nov bills on 12 Nov", () => {
    const due = crateInvoicesDue(cmCrate(), new Set(["2026-09-15"]), [], "2026-11-12");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      period_start: "2026-10-15",
      period_end: "2026-11-11",
      kind: "arrears",
      amount: 84, // 28 days × £3
      days: 28,
    });
  });

  it("month-end start clamps: 31 Aug runs through 29 Sep, daily from 30 Sep", () => {
    const due = crateInvoicesDue(cmCrate({ start_date: "2026-08-31" }), new Set(), [], "2026-08-31");
    expect(due[0]).toMatchObject({ period_start: "2026-08-31", period_end: "2026-09-29", days: 30 });
    const arrears = crateInvoicesDue(
      cmCrate({ start_date: "2026-08-31" }),
      new Set(["2026-08-31"]),
      [],
      "2026-10-28",
    );
    expect(arrears[0]).toMatchObject({ period_start: "2026-09-30", period_end: "2026-10-27", days: 28 });
  });

  it("February clamp: 31 Jan 2027 runs through 27 Feb (28 days); leap 2028 through 28 Feb (29 days)", () => {
    const feb27 = crateInvoicesDue(cmCrate({ start_date: "2027-01-31" }), new Set(), [], "2027-01-31");
    expect(feb27[0]).toMatchObject({ period_end: "2027-02-27", days: 28 });
    const feb28 = crateInvoicesDue(cmCrate({ start_date: "2028-01-31" }), new Set(), [], "2028-01-31");
    expect(feb28[0]).toMatchObject({ period_end: "2028-02-28", days: 29 });
  });

  it("release inside the calendar month owes the minimum only — no day charges (the overcharge case)", () => {
    // End 13 Oct: the 28-day grid would have raised a final for 13 Oct.
    const due = crateInvoicesDue(cmCrate({ end_date: "2026-10-13" }), new Set(["2026-09-15"]), [], "2026-10-13");
    expect(due).toHaveLength(0);
  });

  it("release after the minimum settles the remainder to the exact day immediately", () => {
    // End 20 Oct: final = 15-20 Oct inclusive = 6 days × £3 = £18.
    const due = crateInvoicesDue(cmCrate({ end_date: "2026-10-20" }), new Set(["2026-09-15"]), [], "2026-10-20");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      period_start: "2026-10-15",
      period_end: "2026-10-20",
      kind: "final",
      amount: 18,
      days: 6,
    });
  });

  it("handling events inside the minimum ride the minimum invoice, as before", () => {
    const due = crateInvoicesDue(cmCrate(), new Set(), [ev({ event_date: "2026-09-15" })], "2026-09-15");
    expect(due[0]).toMatchObject({ amount: 156, usageAmount: 84, handlingAmount: 72 });
  });

  it("crateNextInvoiceDate follows the calendar-month window: raise day is 12 Nov for a 15 Sep let", () => {
    expect(crateNextInvoiceDate(cmCrate(), new Set(), "2026-09-01")).toBe("2026-09-15");
    expect(crateNextInvoiceDate(cmCrate(), new Set(["2026-09-15"]), "2026-09-20")).toBe("2026-11-12");
    expect(crateNextInvoiceDate(cmCrate(), new Set(["2026-09-15", "2026-10-15"]), "2026-11-13")).toBe("2026-12-10");
  });

  it("SNAPSHOT CONTROL: min_kind 'days' (and absent) keeps the frozen 28-day behaviour bit for bit", () => {
    for (const over of [{ min_kind: "days" }, {}] as Partial<BillableLet>[]) {
      const legacy = crate({ start_date: "2026-09-15", ...over });
      const min = crateInvoicesDue(legacy, new Set(), [], "2026-09-15");
      expect(min[0]).toMatchObject({ period_end: "2026-10-12", days: 28 });
      const arrears = crateInvoicesDue(legacy, new Set(["2026-09-15"]), [], "2026-11-10");
      expect(arrears[0]).toMatchObject({ period_start: "2026-10-13", period_end: "2026-11-09", days: 28 });
      expect(crateNextInvoiceDate(legacy, new Set(["2026-09-15"]), "2026-09-20")).toBe("2026-11-10");
    }
  });

  it("PERIOD CONTROL: container/period lets are untouched — min_kind never reroutes them", () => {
    const monthly = weekly({ rate: 348, rate_period: "month", min_kind: "calendar_month" });
    const due = invoicesDue(monthly, new Set(), [], "2026-07-01");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ period_start: "2026-07-01", period_end: "2026-07-31", kind: "period", amount: 348 });
    expect(nextInvoiceDate(monthly, new Set(["2026-07-01"]), "2026-07-01")).toBe("2026-08-01");
  });
});

describe("crateNextInvoiceDate / invoicesDue router", () => {
  it("minimum unclaimed → the start day; then each cycle's raise day (window end + 1)", () => {
    expect(crateNextInvoiceDate(crate(), new Set(), "2026-06-25")).toBe("2026-07-01");
    expect(crateNextInvoiceDate(crate(), new Set(["2026-07-01"]), "2026-07-10")).toBe("2026-08-26");
    expect(crateNextInvoiceDate(crate(), new Set(["2026-07-01", "2026-07-29"]), "2026-08-27")).toBe("2026-09-23");
  });

  it("null for ended, paused or unpriced crate lets", () => {
    expect(crateNextInvoiceDate(crate({ end_date: "2026-07-15" }), new Set(), "2026-07-10")).toBeNull();
    expect(crateNextInvoiceDate(crate({ billing_paused: true }), new Set(), "2026-07-10")).toBeNull();
    expect(crateNextInvoiceDate(crate({ rate: null }), new Set(), "2026-07-10")).toBeNull();
  });

  it("invoicesDue routes period lets through the in-advance engine unchanged", () => {
    const due = invoicesDue(weekly(), new Set(), [], "2026-07-01");
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      period_start: "2026-07-01",
      period_end: "2026-07-07",
      kind: "period",
      amount: 25,
      handlingAmount: 0,
      days: 7,
    });
  });

  it("invoicesDue routes crate lets through the daily-arrears engine", () => {
    const due = invoicesDue(crate(), new Set(), [], "2026-07-01");
    expect(due[0].kind).toBe("minimum");
  });
});
