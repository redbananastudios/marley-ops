import { describe, expect, it } from "vitest";
import {
  buildWeeklyDigest,
  digestWeeks,
  gbp,
  trendArrow,
  type DigestInputs,
} from "@/lib/digest/weekly";
import { buildDigestEmailHtml, digestSubject, digestText } from "@/lib/digest/email";

/* Monday 20 Jul 2026 06:00 UTC (07:00 BST) — the real send moment. */
const SEND = new Date("2026-07-20T06:00:00Z");

const emptyInputs = (over?: Partial<DigestInputs>): DigestInputs => ({
  leads: [],
  quotes: [],
  completions: [],
  appointments: [],
  snapshot: { bankTransfersPending: 0, openFollowUps: 0, storageUnitsActive: 0, storageLetsOpen: 0, openClaims: 0 },
  ...over,
});

describe("digestWeeks — UK Monday→Sunday, always the COMPLETED week", () => {
  it("a Monday-morning send reports last Mon–Sun vs the week before", () => {
    const { thisWeek, lastWeek } = digestWeeks(SEND);
    // Completed week = Mon 13 Jul 00:00 UK (BST = 12 Jul 23:00Z) … Mon 20 Jul 00:00 UK.
    expect(thisWeek.start.toISOString()).toBe("2026-07-12T23:00:00.000Z");
    expect(thisWeek.end.toISOString()).toBe("2026-07-19T23:00:00.000Z");
    expect(lastWeek.start.toISOString()).toBe("2026-07-05T23:00:00.000Z");
    expect(thisWeek.label).toBe("13 Jul – 19 Jul");
    expect(lastWeek.label).toBe("6 Jul – 12 Jul");
  });

  it("a mid-week run reports the SAME completed week (numbers never move under the reader)", () => {
    const wednesday = new Date("2026-07-22T15:00:00Z");
    expect(digestWeeks(wednesday).thisWeek.label).toBe(digestWeeks(SEND).thisWeek.label);
  });

  it("UK midnight boundaries hold in winter too (no BST offset)", () => {
    const janMonday = new Date("2026-01-12T06:00:00Z");
    const { thisWeek } = digestWeeks(janMonday);
    expect(thisWeek.start.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });
});

describe("buildWeeklyDigest — the numbers", () => {
  it("money in = deposits paid + balances paid (balance value via the lead's quote)", () => {
    const d = buildWeeklyDigest(
      emptyInputs({
        leads: [
          { id: "l1", created_at: "2026-07-01T10:00:00Z", lost_at: null, balance_paid_at: "2026-07-15T10:00:00Z" },
        ],
        quotes: [
          {
            lead_id: "l1",
            quote_ref: "MMR001",
            customer_name: "Jane Smith",
            email_sent_at: null,
            accepted_at: null,
            deposit_paid_at: "2026-07-14T09:00:00Z",
            deposit_amount: 100,
            agreed_price: 1020,
            grand_total: null,
            balance_invoice_amount: 920,
          },
        ],
      }),
      SEND,
    );
    expect(d.thisWeek.moneyIn).toBe(1020); // £100 deposit + £920 balance
    expect(d.lastWeek.moneyIn).toBe(0);
  });

  it("a price-revision supersede (deposit copied onto the new quote) counts the deposit once per lead", () => {
    const q = (over: Record<string, unknown>) => ({
      lead_id: "l1",
      quote_ref: "MMR010",
      customer_name: "Jane Smith",
      email_sent_at: null,
      accepted_at: null,
      deposit_paid_at: "2026-07-14T09:00:00Z",
      deposit_amount: 100,
      agreed_price: null,
      grand_total: null,
      balance_invoice_amount: null,
      ...over,
    });
    const d = buildWeeklyDigest(
      emptyInputs({
        quotes: [
          q({ agreed_price: 1000 }), // superseded original, deposit fields intact
          q({ quote_ref: "MMR011", agreed_price: 1200 }), // re-quote carrying the copied deposit
          // lead-less quotes still count individually
          q({ lead_id: null, quote_ref: "MMR012", deposit_amount: 50 }),
          q({ lead_id: null, quote_ref: "MMR013", deposit_amount: 50 }),
        ],
      }),
      SEND,
    );
    expect(d.thisWeek.moneyIn).toBe(200); // £100 once for l1 + £50 + £50
  });

  it("wins/sent/lost land in the right week; biggest win is named first-name-only", () => {
    const q = (over: Record<string, unknown>) => ({
      lead_id: null,
      quote_ref: "MMR002",
      customer_name: "Freddy Arbuthnot",
      email_sent_at: null,
      accepted_at: null,
      deposit_paid_at: null,
      deposit_amount: null,
      agreed_price: null,
      grand_total: null,
      balance_invoice_amount: null,
      ...over,
    });
    const d = buildWeeklyDigest(
      emptyInputs({
        leads: [
          { id: "a", created_at: "2026-07-14T10:00:00Z", lost_at: null, balance_paid_at: null },
          { id: "b", created_at: "2026-07-08T10:00:00Z", lost_at: "2026-07-16T10:00:00Z", balance_paid_at: null },
        ],
        quotes: [
          q({ email_sent_at: "2026-07-13T09:00:00Z", grand_total: 800 }),
          q({ quote_ref: "MMR003", accepted_at: "2026-07-15T09:00:00Z", agreed_price: 1800 }),
          q({ quote_ref: "MMR004", accepted_at: "2026-07-16T09:00:00Z", grand_total: 600, customer_name: "ann other" }),
          // last week's acceptance stays out of this week's wins
          q({ quote_ref: "MMR005", accepted_at: "2026-07-08T09:00:00Z", agreed_price: 5000 }),
        ],
      }),
      SEND,
    );
    expect(d.thisWeek.enquiries).toBe(1);
    expect(d.lastWeek.enquiries).toBe(1);
    expect(d.thisWeek.quotesSent).toBe(1);
    expect(d.thisWeek.quotesSentValue).toBe(800);
    expect(d.thisWeek.wins).toBe(2);
    expect(d.thisWeek.winsValue).toBe(2400);
    expect(d.thisWeek.lost).toBe(1);
    expect(d.biggestWin).toEqual({ quoteRef: "MMR003", firstName: "Freddy", value: 1800 });
  });

  it("surveys exclude cancelled; forward look counts the next 7 days only", () => {
    const d = buildWeeklyDigest(
      emptyInputs({
        appointments: [
          { appt_type: "survey", status: "scheduled", starts_at: "2026-07-15T10:00:00Z" },
          { appt_type: "survey", status: "cancelled", starts_at: "2026-07-15T12:00:00Z" },
          { appt_type: "removal", status: "scheduled", starts_at: "2026-07-22T08:00:00Z" },
          { appt_type: "removal", status: "scheduled", starts_at: "2026-08-05T08:00:00Z" }, // beyond 7 days
          { appt_type: "survey", status: "scheduled", starts_at: "2026-07-21T09:00:00Z" },
        ],
      }),
      SEND,
    );
    expect(d.thisWeek.surveysDone).toBe(1);
    expect(d.nextWeekMoves).toBe(1);
    expect(d.nextWeekSurveys).toBe(1);
  });

  it("exceptions recorded this week surface as a metric", () => {
    const d = buildWeeklyDigest(
      emptyInputs({
        completions: [
          { created_at: "2026-07-14T16:00:00Z", exceptions: "scratch to wardrobe door" },
          { created_at: "2026-07-15T16:00:00Z", exceptions: "  " },
        ],
      }),
      SEND,
    );
    expect(d.thisWeek.jobsCompleted).toBe(2);
    expect(d.thisWeek.exceptionsRecorded).toBe(1);
  });
});

describe("digest email", () => {
  const digest = buildWeeklyDigest(
    emptyInputs({
      quotes: [
        {
          lead_id: null,
          quote_ref: "MMR009",
          customer_name: "Jane Smith",
          email_sent_at: null,
          accepted_at: "2026-07-15T09:00:00Z",
          deposit_paid_at: "2026-07-15T10:00:00Z",
          deposit_amount: 100,
          agreed_price: 1500,
          grand_total: null,
          balance_invoice_amount: null,
        },
      ],
      snapshot: { bankTransfersPending: 2, openFollowUps: 3, storageUnitsActive: 4, storageLetsOpen: 1, openClaims: 1 },
    }),
    SEND,
  );

  it("subject leads with the headline numbers", () => {
    expect(digestSubject(digest)).toBe("Marley week 13 Jul – 19 Jul: £100 in · 1 won · 0 jobs done");
  });

  it("html carries the comparison, the attention block, and deep links — no full customer names", () => {
    const html = buildDigestEmailHtml(digest);
    expect(html).toContain("This week");
    expect(html).toContain("Last week");
    expect(html).toContain("bank transfer");
    expect(html).toContain("open claim");
    expect(html).toContain("ops.marleymoves.co.uk/claims");
    expect(html).toContain("ops.marleymoves.co.uk/performance");
    expect(html).toContain("Jane's move");
    expect(html).not.toContain("Jane Smith");
  });

  it("attention block disappears when there's nothing to flag", () => {
    const quiet = buildWeeklyDigest(emptyInputs(), SEND);
    expect(buildDigestEmailHtml(quiet)).not.toContain("Needs attention");
    expect(digestText(quiet)).not.toContain("Needs attention");
  });

  it("gbp + trendArrow behave", () => {
    expect(gbp(15659.11)).toBe("£15,659");
    expect(trendArrow(5, 3)).toBe("▲");
    expect(trendArrow(1, 3)).toBe("▼");
    expect(trendArrow(2, 2)).toBe("—");
  });
});
