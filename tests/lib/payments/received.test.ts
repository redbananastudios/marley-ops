import { describe, expect, it } from "vitest";
import {
  buildReceivedDay,
  ukDayWindow,
  ukRangeWindow,
  type CardRowIn,
  type LeadIn,
  type QuoteIn,
} from "@/lib/payments/received";

/* --------------------------------------------------------------- fixtures */

const quote = (over: Partial<QuoteIn> = {}): QuoteIn => ({
  id: "q1",
  quote_ref: "MMR001",
  lead_id: "l1",
  customer_name: "Freddy Arbuthnot",
  agreed_price: 1200,
  grand_total: 1200,
  deposit_amount: 100,
  deposit_paid_at: null,
  balance_invoice_amount: null,
  ...over,
});

const cardRow = (over: Partial<CardRowIn> = {}): CardRowIn => ({
  id: "cp1",
  kind: "deposit",
  status: "paid",
  amount_pence: 10000,
  refunded_pence: 0,
  is_test: false,
  settled_at: "2026-07-15T09:00:00Z",
  refunded_at: null,
  refund_reason: null,
  quote_id: "q1",
  lead_id: "l1",
  card_number_mask: "************4242",
  card_scheme: "Visa",
  ...over,
});

const lead = (over: Partial<LeadIn> = {}): LeadIn => ({
  id: "l1",
  name: "Freddy Arbuthnot",
  balance_paid_at: null,
  balance_amount: null,
  ...over,
});

// 2026-07-15 is BST: the UK day runs 14th 23:00Z → 15th 23:00Z.
const WINDOW = { start: new Date("2026-07-14T23:00:00Z"), end: new Date("2026-07-15T23:00:00Z") };

const build = (over: Partial<Parameters<typeof buildReceivedDay>[0]> = {}) =>
  buildReceivedDay({
    window: WINDOW,
    cardRows: [],
    depositQuotes: [],
    balanceLeads: [],
    quoteByLeadId: new Map([["l1", quote()]]),
    ...over,
  });

/* ------------------------------------------------------------ ukDayWindow */

describe("ukDayWindow", () => {
  it("BST day boundaries are 23:00Z the night before", () => {
    const w = ukDayWindow("2026-07-15", new Date("2026-07-15T10:00:00Z"));
    expect(w.start.toISOString()).toBe("2026-07-14T23:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-07-15T23:00:00.000Z");
    expect(w.day).toBe("2026-07-15");
    expect(w.prev).toBe("2026-07-14");
    expect(w.next).toBe("2026-07-16");
    expect(w.isToday).toBe(true);
  });

  it("winter day boundaries are midnight UTC", () => {
    const w = ukDayWindow("2026-01-10", new Date("2026-07-15T10:00:00Z"));
    expect(w.start.toISOString()).toBe("2026-01-10T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-01-11T00:00:00.000Z");
    expect(w.isToday).toBe(false);
  });

  it("month boundaries roll prev/next correctly", () => {
    const w = ukDayWindow("2026-08-01", new Date("2026-07-15T10:00:00Z"));
    expect(w.prev).toBe("2026-07-31");
    expect(w.next).toBe("2026-08-02");
  });

  it("garbage and impossible dates fall back to today (UK)", () => {
    // 22:30Z on 15 July = 23:30 UK — already the 15th either way, but 23:30Z
    // would be the UK 16th; use it to prove the UK calendar wins.
    const w = ukDayWindow("2026-02-31", new Date("2026-07-15T23:30:00Z"));
    expect(w.day).toBe("2026-07-16");
    const w2 = ukDayWindow("not-a-date", new Date("2026-07-15T10:00:00Z"));
    expect(w2.day).toBe("2026-07-15");
  });
});

/* -------------------------------------------------------- buildReceivedDay */

describe("buildReceivedDay", () => {
  it("counts a card deposit settled in the window", () => {
    const day = build({ cardRows: [cardRow()] });
    expect(day.items).toHaveLength(1);
    expect(day.items[0]).toMatchObject({
      source: "card",
      kind: "deposit",
      amountPence: 10000,
      quoteRef: "MMR001",
      customer: "Freddy Arbuthnot",
    });
    expect(day.cardPence).toBe(10000);
    expect(day.totalPence).toBe(10000);
  });

  it("ignores card rows settled outside the window and non-money statuses", () => {
    const day = build({
      cardRows: [
        cardRow({ id: "old", settled_at: "2026-07-13T09:00:00Z" }),
        cardRow({ id: "pending", status: "pending", settled_at: null }),
        cardRow({ id: "failed", status: "failed", settled_at: null }),
      ],
    });
    expect(day.items).toHaveLength(0);
    expect(day.totalPence).toBe(0);
  });

  it("lists test attempts but keeps them out of every total", () => {
    const day = build({ cardRows: [cardRow({ is_test: true })] });
    expect(day.items).toHaveLength(1);
    expect(day.items[0].isTest).toBe(true);
    expect(day.cardPence).toBe(0);
    expect(day.totalPence).toBe(0);
  });

  it("shows a refund as a negative line and nets it off the card total", () => {
    const day = build({
      cardRows: [
        cardRow({
          status: "partially_refunded",
          refunded_pence: 4000,
          refunded_at: "2026-07-15T14:00:00Z",
          refund_reason: "Overcharged boxes",
        }),
      ],
    });
    expect(day.items).toHaveLength(2);
    const refund = day.items.find((i) => i.kind === "refund")!;
    expect(refund.amountPence).toBe(-4000);
    expect(refund.note).toBe("Overcharged boxes");
    expect(day.cardPence).toBe(6000);
  });

  it("a same-day void nets to zero but both lines show", () => {
    const day = build({
      cardRows: [
        cardRow({
          status: "voided",
          refunded_pence: 10000,
          refunded_at: "2026-07-15T09:30:00Z",
        }),
      ],
    });
    expect(day.items).toHaveLength(2);
    expect(day.cardPence).toBe(0);
  });

  it("counts a refund whose capture settled on an earlier day", () => {
    const day = build({
      cardRows: [
        cardRow({
          status: "refunded",
          settled_at: "2026-07-10T09:00:00Z",
          refunded_pence: 10000,
          refunded_at: "2026-07-15T11:00:00Z",
        }),
      ],
    });
    expect(day.items).toHaveLength(1);
    expect(day.items[0].kind).toBe("refund");
    expect(day.cardPence).toBe(-10000);
  });

  it("counts a recorded (BACS) deposit and balance", () => {
    const day = build({
      depositQuotes: [quote({ deposit_paid_at: "2026-07-15T08:00:00Z" })],
      balanceLeads: [lead({ balance_paid_at: "2026-07-15T16:00:00Z", balance_amount: 1100 })],
    });
    expect(day.items).toHaveLength(2);
    expect(day.recordedPence).toBe(10000 + 110000);
    expect(day.cardPence).toBe(0);
    expect(day.totalPence).toBe(120000);
  });

  it("skips £0 deposits (legacy iMVE settled-by-definition markers — no money moved)", () => {
    const day = build({
      depositQuotes: [quote({ deposit_paid_at: "2026-07-15T08:00:00Z", deposit_amount: 0 })],
    });
    expect(day.items).toHaveLength(0);
    expect(day.totalPence).toBe(0);
  });

  it("drops the recorded deposit when a card receipt covers the same quote (no double count)", () => {
    const day = build({
      cardRows: [cardRow()],
      depositQuotes: [quote({ deposit_paid_at: "2026-07-15T09:00:01Z" })],
    });
    expect(day.items).toHaveLength(1);
    expect(day.items[0].source).toBe("card");
    expect(day.totalPence).toBe(10000);
  });

  it("counts a recorded commitment payment (BACS/cash — never card, no dedupe)", () => {
    const day = build({
      commitmentQuotes: [
        quote({ commitment_invoice_amount: 50, commitment_paid_at: "2026-07-15T11:00:00Z" }),
      ],
    });
    expect(day.items).toHaveLength(1);
    expect(day.items[0]).toMatchObject({
      source: "recorded",
      kind: "commitment",
      quoteRef: "MMR001",
      amountPence: 5000,
    });
    expect(day.recordedPence).toBe(5000);
    expect(day.totalPence).toBe(5000);
  });

  it("a commitment paid outside the window does not count", () => {
    const day = build({
      commitmentQuotes: [
        quote({ commitment_invoice_amount: 50, commitment_paid_at: "2026-07-16T11:00:00Z" }),
      ],
    });
    expect(day.items).toHaveLength(0);
  });

  it("falls back agreed − deposit for a balance with no stored amount", () => {
    const day = build({
      balanceLeads: [lead({ balance_paid_at: "2026-07-15T16:00:00Z" })],
    });
    expect(day.items[0].amountPence).toBe(110000); // 1200 − 100
  });

  it("the balance fallback nets out a RAISED commitment invoice", () => {
    const day = build({
      balanceLeads: [lead({ balance_paid_at: "2026-07-15T16:00:00Z" })],
      quoteByLeadId: new Map([["l1", quote({ commitment_invoice_amount: 200 })]]),
    });
    expect(day.items[0].amountPence).toBe(90000); // 1200 − 100 − 200
  });

  it("sorts newest first", () => {
    const day = build({
      cardRows: [cardRow({ settled_at: "2026-07-15T09:00:00Z" })],
      balanceLeads: [lead({ balance_paid_at: "2026-07-15T16:00:00Z", balance_amount: 500 })],
    });
    expect(day.items.map((i) => i.kind)).toEqual(["balance", "deposit"]);
  });

  it("carries the payment rail per item and totals per method", () => {
    const day = build({
      cardRows: [cardRow({ settled_at: "2026-07-15T09:00:00Z", quote_id: "qX", lead_id: "lX" })],
      depositQuotes: [
        quote({
          id: "q2",
          quote_ref: "MMR002",
          lead_id: "l2",
          deposit_paid_at: "2026-07-15T10:00:00Z",
          deposit_paid_method: "cash",
        }),
      ],
      commitmentQuotes: [
        quote({
          id: "q3",
          quote_ref: "MMR003",
          lead_id: "l3",
          commitment_invoice_amount: 200,
          commitment_paid_at: "2026-07-15T11:00:00Z",
          commitment_paid_method: "bank_transfer",
        }),
      ],
      // Pre-stamp balance: method column null → unknown bucket, never guessed.
      balanceLeads: [lead({ balance_paid_at: "2026-07-15T16:00:00Z", balance_amount: 500 })],
    });
    const byKind = Object.fromEntries(
      day.items.filter((i) => i.source === "recorded").map((i) => [i.kind, i.method]),
    );
    expect(byKind).toEqual({ deposit: "cash", commitment: "bank_transfer", balance: null });
    // The card row's lead has no quote in quoteByLeadId here, but its rail is
    // structural: card rows are always method "card".
    expect(day.items.every((i) => i.source !== "card" || i.method === "card")).toBe(true);
    expect(day.methodPence).toEqual({ card: 10000, bank: 20000, cash: 10000, unknown: 50000 });
    expect(day.totalPence).toBe(90000);
  });
});

/* ------------------------------------------------------------- ukRangeWindow */

describe("ukRangeWindow (Mon–Sun weeks — Peter, 2026-08-16)", () => {
  // Sat 15 Aug 2026, 12:00 UK (11:00Z in BST).
  const now = new Date("2026-08-15T11:00:00Z");

  it("defaults to the current Monday–Sunday week", () => {
    const w = ukRangeWindow(undefined, now);
    expect(w.preset).toBe("this-week");
    expect(w.startDay).toBe("2026-08-10"); // Monday
    expect(w.endDay).toBe("2026-08-16"); // Sunday
  });

  it("a Monday 'today' is its own week start (offset 0)", () => {
    const w = ukRangeWindow(undefined, new Date("2026-08-10T11:00:00Z"));
    expect(w.startDay).toBe("2026-08-10");
    expect(w.endDay).toBe("2026-08-16");
  });

  it("last-week is the previous Mon–Sun; this-month runs 1st to month end", () => {
    const lw = ukRangeWindow({ preset: "last-week" }, now);
    expect([lw.startDay, lw.endDay]).toEqual(["2026-08-03", "2026-08-09"]);
    const m = ukRangeWindow({ preset: "this-month" }, now);
    expect([m.startDay, m.endDay]).toEqual(["2026-08-01", "2026-08-31"]);
  });

  it("today is a single day; the window's end is the NEXT UK midnight", () => {
    const w = ukRangeWindow({ preset: "today" }, now);
    expect(w.startDay).toBe("2026-08-15");
    expect(w.endDay).toBe("2026-08-15");
    // BST: UK midnight is 23:00Z the previous evening.
    expect(w.start.toISOString()).toBe("2026-08-14T23:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-08-15T23:00:00.000Z");
  });

  it("custom validates: impossible dates, from>to and 400+ day spans fall back to this-week", () => {
    const good = ukRangeWindow({ preset: "custom", from: "2026-08-01", to: "2026-08-14" }, now);
    expect([good.preset, good.startDay, good.endDay]).toEqual(["custom", "2026-08-01", "2026-08-14"]);
    for (const bad of [
      { from: "2026-02-31", to: "2026-08-14" },
      { from: "2026-08-14", to: "2026-08-01" },
      { from: "2020-01-01", to: "2026-08-14" },
      { from: null, to: "2026-08-14" },
    ]) {
      expect(ukRangeWindow({ preset: "custom", ...bad }, now).preset).toBe("this-week");
    }
  });
});
