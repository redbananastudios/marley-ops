import { describe, expect, it } from "vitest";
import { buildPeriodStats, isWonQuote, type LeadLite, type ProgressSets } from "@/lib/dashboard/compute";

/* Fixed "now" inside BST so the today/month windows are deterministic. */
const NOW = new Date("2026-07-15T12:00:00+01:00").getTime();

const lead = (o: Partial<LeadLite>): LeadLite => ({
  id: o.id ?? "l",
  name: null,
  status: "website_enquiry",
  entry_channel: "manual",
  from_postcode: null,
  to_postcode: null,
  submitted_at: "2026-07-15T09:00:00+01:00",
  created_at: null,
  first_contacted_at: null,
  gclid: null,
  gbraid: null,
  wbraid: null,
  fbclid: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  ...o,
});

const emptyProg = (): ProgressSets => ({
  surveyed: new Set<string>(),
  quoted: new Set<string>(),
  won: new Map<string, number>(),
  cost: new Map<string, number>(),
});

describe("isWonQuote (H1 — cancelled bookings must not count as won)", () => {
  it("counts a standing accepted quote", () => {
    expect(isWonQuote({ status: "accepted", lead_id: "l1", booking_cancelled_at: null })).toBe(true);
  });

  it("drops an accepted quote whose booking was cancelled", () => {
    // markLeadLostAction / cancelBookingAction leave status='accepted' and only
    // stamp booking_cancelled_at — the money surfaces must exclude it.
    expect(isWonQuote({ status: "accepted", lead_id: "l1", booking_cancelled_at: "2026-07-14T10:00:00Z" })).toBe(false);
  });

  it("drops an accepted quote with no lead", () => {
    expect(isWonQuote({ status: "accepted", lead_id: null, booking_cancelled_at: null })).toBe(false);
  });

  it("drops a non-accepted quote", () => {
    expect(isWonQuote({ status: "sent", lead_id: "l1", booking_cancelled_at: null })).toBe(false);
  });
});

describe("buildPeriodStats — won cohort excludes a cancelled (declined) lead", () => {
  it("does not count a declined lead absent from prog.won as a job", () => {
    // The cancelled booking: lead flipped to 'declined', and its cancelled quote
    // was filtered out of prog.won by isWonQuote at build time.
    const leads = [
      lead({ id: "won", status: "confirmed" }),
      lead({ id: "cancelled", status: "declined" }),
    ];
    const prog = emptyProg();
    prog.won.set("won", 2000);
    prog.cost.set("won", 800);

    const s = buildPeriodStats("today", leads, prog, NOW, null);
    expect(s.jobs).toBe(1);
    expect(s.wonValue).toBe(2000);
    expect(s.wonCost).toBe(800);
    expect(s.margin).toBe(1200);
  });
});

describe("buildPeriodStats — medianRespMins re-scopes per period (L1)", () => {
  it("is the median of first-response over the period's cohort only", () => {
    const leads = [
      lead({ id: "a", first_contacted_at: "2026-07-15T09:10:00+01:00" }), // 10 min
      lead({ id: "b", first_contacted_at: "2026-07-15T09:20:00+01:00" }), // 20 min
      lead({ id: "c", first_contacted_at: "2026-07-15T10:00:00+01:00" }), // 60 min
      // Older lead answered in 100 min — inside the month window, NOT today's.
      lead({
        id: "old",
        submitted_at: "2026-06-25T09:00:00+01:00",
        first_contacted_at: "2026-06-25T10:40:00+01:00",
      }),
    ];
    const prog = emptyProg();

    const today = buildPeriodStats("today", leads, prog, NOW, null);
    expect(today.medianRespMins).toBe(20); // median of [10, 20, 60]; the slow old lead is out of scope

    const month = buildPeriodStats("month", leads, prog, NOW, null);
    expect(month.medianRespMins).toBe(60); // median of [10, 20, 60, 100] → index 2 = 60
  });

  it("is null when no cohort lead was contacted", () => {
    const s = buildPeriodStats("today", [lead({ id: "x" })], emptyProg(), NOW, null);
    expect(s.medianRespMins).toBeNull();
  });
});
