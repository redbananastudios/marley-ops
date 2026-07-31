import { describe, expect, it } from "vitest";
import {
  buildSalesReport,
  dedupePerLead,
  quoteSentDay,
  ukDayOf,
  type SalesLead,
  type SalesQuote,
} from "@/lib/sales-report";

const FROM = "2026-07-01";
const TO = "2026-07-31";

const quote = (o: Partial<SalesQuote>): SalesQuote => ({
  id: o.id ?? "q",
  lead_id: null,
  status: "sent",
  grand_total: 1000,
  agreed_price: null,
  created_at: "2026-07-10T10:00:00+01:00",
  email_sent_at: "2026-07-10T10:00:00+01:00",
  accepted_at: null,
  moving_date: null,
  deposit_amount: null,
  deposit_paid_at: null,
  ...o,
});

const lead = (o: Partial<SalesLead>): SalesLead => ({
  id: o.id ?? "l",
  status: "quoted",
  submitted_at: "2026-07-05T09:00:00+01:00",
  created_at: null,
  preferred_date: null,
  balance_amount: null,
  balance_paid_at: null,
  entry_channel: "manual",
  gclid: null,
  gbraid: null,
  wbraid: null,
  fbclid: null,
  utm_source: null,
  utm_medium: null,
  ...o,
});

describe("ukDayOf", () => {
  it("passes date strings through and converts timestamps to UK days", () => {
    expect(ukDayOf("2026-07-15")).toBe("2026-07-15");
    expect(ukDayOf("2026-07-13T23:30:00Z")).toBe("2026-07-14"); // BST
    expect(ukDayOf(null)).toBeNull();
  });
});

describe("quoteSentDay / dedupePerLead", () => {
  it("drafts never count as sent; email stamp wins over created", () => {
    expect(quoteSentDay(quote({ status: "draft" }))).toBeNull();
    expect(quoteSentDay(quote({ email_sent_at: null, created_at: "2026-07-02T09:00:00+01:00" }))).toBe("2026-07-02");
  });

  it("keeps the accepted quote over a newer sent one, else the latest", () => {
    const a = quote({ id: "a", lead_id: "L", status: "accepted", created_at: "2026-07-01T09:00:00+01:00" });
    const b = quote({ id: "b", lead_id: "L", status: "sent", created_at: "2026-07-05T09:00:00+01:00" });
    expect(dedupePerLead([a, b]).map((q) => q.id)).toEqual(["a"]);
    const c = quote({ id: "c", lead_id: "L", status: "sent", created_at: "2026-07-01T09:00:00+01:00" });
    expect(dedupePerLead([c, b]).map((q) => q.id)).toEqual(["b"]);
  });

  it("superseded quotes vanish entirely", () => {
    expect(dedupePerLead([quote({ lead_id: "L", status: "superseded" })])).toEqual([]);
  });
});

describe("buildSalesReport", () => {
  it("the four revenue lenses measure different things", () => {
    const quotes = [
      // won in June, moving in July, £100 deposit paid in July
      quote({
        id: "q1",
        lead_id: "l1",
        status: "accepted",
        agreed_price: 1200,
        grand_total: 1300,
        accepted_at: "2026-06-20T10:00:00+01:00",
        moving_date: "2026-07-15",
        deposit_amount: 100,
        deposit_paid_at: "2026-07-02T10:00:00+01:00",
        created_at: "2026-06-18T10:00:00+01:00",
        email_sent_at: "2026-06-18T10:00:00+01:00",
      }),
      // won in July, moving in August
      quote({
        id: "q2",
        lead_id: "l2",
        status: "accepted",
        agreed_price: 800,
        grand_total: 800,
        accepted_at: "2026-07-10T10:00:00+01:00",
        moving_date: "2026-08-03",
      }),
      // sent in July, no outcome yet
      quote({ id: "q3", lead_id: "l3", grand_total: 950 }),
    ];
    const leads = [
      lead({ id: "l1", status: "completed", balance_amount: 1100, balance_paid_at: "2026-07-16T18:00:00+01:00" }),
      lead({ id: "l2", status: "confirmed" }),
      lead({ id: "l3" }),
    ];
    const r = buildSalesReport(quotes, leads, [], FROM, TO);

    expect(r.generated).toEqual({ total: 1200, count: 1 }); // moving in July (agreed price wins)
    expect(r.paid).toEqual({ total: 1200, count: 2 }); // £100 deposit + £1,100 balance
    expect(r.projected).toEqual({ total: 800, count: 1 }); // won in July
    expect(r.potential).toEqual({ total: 950 + 800, count: 2 }); // q2+q3 sent in July; q1 sent in June
    expect(r.jobsCompleted).toBe(1); // l1 completed, moved in July
    expect(r.avgJobValue).toBe(800);
  });

  it("conversion counts the period's enquiries won so far", () => {
    const leads = [
      lead({ id: "a", status: "confirmed" }),
      lead({ id: "b", status: "quoted" }),
      lead({ id: "c", status: "declined" }),
      lead({ id: "june", submitted_at: "2026-06-15T09:00:00+01:00", status: "confirmed" }), // outside range
    ];
    const r = buildSalesReport([], leads, [], FROM, TO);
    expect(r.enquiries).toBe(3);
    expect(r.won).toBe(1);
    expect(r.conversionPct).toBe(33);
  });

  it("same-day quoting compares survey day to quote-sent day", () => {
    const quotes = [
      quote({ id: "s1", lead_id: "l1", email_sent_at: "2026-07-08T17:00:00+01:00" }),
      quote({ id: "s2", lead_id: "l2", email_sent_at: "2026-07-09T09:00:00+01:00" }),
    ];
    const leads = [lead({ id: "l1" }), lead({ id: "l2" }), lead({ id: "l3" })];
    const surveys = [
      { lead_id: "l1", starts_at: "2026-07-08T10:00:00+01:00" }, // quoted same day
      { lead_id: "l2", starts_at: "2026-07-08T14:00:00+01:00" }, // quoted next day
      { lead_id: "l3", starts_at: "2026-07-08T16:00:00+01:00" }, // never quoted — excluded
    ];
    const r = buildSalesReport(quotes, leads, surveys, FROM, TO);
    expect(r.sameDay).toEqual({ same: 1, of: 2, pct: 50 });
  });

  it("funnel buckets: accepted / declined / lost / awaiting, one quote per lead", () => {
    const quotes = [
      quote({ id: "a", lead_id: "l1", status: "accepted", accepted_at: "2026-07-11T10:00:00+01:00" }),
      quote({ id: "b", lead_id: "l2", status: "rejected" }),
      quote({ id: "c", lead_id: "l3" }), // lead declined → lost
      quote({ id: "d", lead_id: "l4" }), // awaiting
      quote({ id: "d2", lead_id: "l4", status: "superseded" }), // ignored
    ];
    const leads = [
      lead({ id: "l1", status: "confirmed" }),
      lead({ id: "l2" }),
      lead({ id: "l3", status: "declined" }),
      lead({ id: "l4" }),
    ];
    const r = buildSalesReport(quotes, leads, [], FROM, TO);
    expect(r.funnel).toEqual({ sent: 4, accepted: 1, declined: 1, awaiting: 1, lost: 1, pct: 25 });
  });

  it("per-source rollup credits won value to the enquiry's source", () => {
    const quotes = [
      quote({ id: "a", lead_id: "ads", status: "accepted", agreed_price: 900, accepted_at: "2026-07-12T10:00:00+01:00" }),
    ];
    const leads = [
      lead({ id: "ads", gclid: "x", status: "confirmed" }),
      lead({ id: "org" }),
    ];
    const r = buildSalesReport(quotes, leads, [], FROM, TO);
    const ads = r.bySource.find((s) => s.key === "google_ads");
    const org = r.bySource.find((s) => s.key === "manual");
    expect(ads).toMatchObject({ enquiries: 1, won: 1, value: 900 });
    expect(org).toMatchObject({ enquiries: 1, won: 0, value: 0 });
  });

  it("a deposit carried onto a re-quote counts once, not per superseded row", () => {
    // Re-quote path: old quote superseded, its paid deposit copied onto the new
    // accepted quote — the stamp exists on BOTH rows. Only the live one may count.
    const quotes = [
      quote({
        id: "old",
        lead_id: "L",
        status: "superseded",
        deposit_amount: 100,
        deposit_paid_at: "2026-07-05T10:00:00+01:00",
      }),
      quote({
        id: "new",
        lead_id: "L",
        status: "accepted",
        agreed_price: 2200,
        accepted_at: "2026-07-06T10:00:00+01:00",
        deposit_amount: 100,
        deposit_paid_at: "2026-07-05T10:00:00+01:00",
      }),
    ];
    const r = buildSalesReport(quotes, [lead({ id: "L", status: "confirmed" })], [], FROM, TO);
    expect(r.paid).toEqual({ total: 100, count: 1 }); // the single £100 actually received
  });

  it("empty period returns nulls, not divide-by-zero", () => {
    const r = buildSalesReport([], [], [], FROM, TO);
    expect(r.conversionPct).toBeNull();
    expect(r.avgJobValue).toBeNull();
    expect(r.sameDay.pct).toBeNull();
    expect(r.funnel.pct).toBeNull();
  });
});
