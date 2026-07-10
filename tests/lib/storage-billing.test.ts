import { describe, expect, it } from "vitest";
import {
  MAX_PERIODS_PER_RUN,
  nextInvoiceDate,
  nextPeriodStart,
  periodEnd,
  periodsDue,
  storageInvoiceReference,
  type BillableLet,
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
});

describe("storageInvoiceReference", () => {
  it("is stable per let+period (the Zoho adoption key)", () => {
    expect(storageInvoiceReference("11111111-2222-4333-8444-555555555555", "2026-07-01")).toBe(
      "MMS-11111111-2026-07-01",
    );
  });
});
