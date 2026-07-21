import { describe, expect, it } from "vitest";
import {
  buildRefundQueueView,
  cardExecutedPence,
  effectiveDetermination,
  executionForPlan,
  notFilledAllowed,
  outstandingSummary,
  parseHeld,
  planForRow,
  sectionFor,
  type CardStateIn,
  type QueueRowIn,
  type QuoteRefIn,
} from "@/lib/refunds/queue-view";
import type { HeldPayment, PaymentRail } from "@/lib/payments-policy";

/**
 * /refunds queue view — pure engine (Payments Policy v2). The maths asserted
 * here is what the page renders and what the server actions re-verify before
 * money moves: sectioning, per-rail refund/retain splits, executed state and
 * the penny-exact conservation of every held payment.
 */

const held = (over: Partial<HeldPayment> = {}): HeldPayment => ({
  rail: "bank_transfer",
  amount: 100,
  at: "2026-07-01T10:00:00Z",
  label: "deposit",
  ...over,
});

const row = (over: Partial<QueueRowIn> = {}): QueueRowIn => ({
  id: "rq-1",
  created_at: "2026-07-20T10:00:00Z",
  lead_id: "l-1",
  quote_id: "q-1",
  original_move_date: "2026-08-14",
  trigger: "customer_cancel",
  held: [held()],
  conditional_amount: 100,
  unconditional_amount: 0,
  determination: null,
  determined_by: null,
  determined_at: null,
  status: "pending",
  executed_by: null,
  executed_at: null,
  shortfall_note: null,
  cash_recipient_name: null,
  cash_recipient_sort: null,
  cash_recipient_account: null,
  notes: null,
  ...over,
});

const quotesById = new Map<string, QuoteRefIn>([
  ["q-1", { quote_ref: "MMR001", customer_name: "Freddy Arbuthnot", lead_id: "l-1" }],
]);

const view = (rows: QueueRowIn[], extra: Partial<Parameters<typeof buildRefundQueueView>[0]> = {}) =>
  buildRefundQueueView({
    rows,
    quotesById,
    cardStatesById: new Map(),
    railMarks: [],
    todayUkDay: "2026-07-22",
    ...extra,
  });

/* ----------------------------------------------------------- parseHeld */

describe("parseHeld", () => {
  it("keeps valid entries and normalises chronological order", () => {
    const out = parseHeld([
      held({ at: "2026-07-05T10:00:00Z", label: "commitment" }),
      held({ at: "2026-07-01T10:00:00Z" }),
    ]);
    expect(out.map((h) => h.label)).toEqual(["deposit", "commitment"]);
  });

  it("skips malformed, unknown-rail, zero and NEGATIVE amounts", () => {
    const out = parseHeld([
      null,
      "junk",
      { rail: "paypal", amount: 100, at: "2026-07-01" },
      { rail: "card", amount: 0, at: "2026-07-01" },
      { rail: "card", amount: -50, at: "2026-07-01" },
      { rail: "card", amount: Number.NaN, at: "2026-07-01" },
      { rail: "card", amount: 100 }, // no at
      held({ rail: "cash", amount: 25 }),
    ]);
    expect(out).toEqual([expect.objectContaining({ rail: "cash", amount: 25 })]);
  });

  it("returns [] for a non-array snapshot", () => {
    expect(parseHeld(null)).toEqual([]);
    expect(parseHeld({})).toEqual([]);
  });
});

/* ------------------------------------------------- effective determination */

describe("effectiveDetermination", () => {
  it("an answered question wins", () => {
    expect(effectiveDetermination({ trigger: "customer_cancel", determination: "not_filled", conditional_amount: 100 })).toBe("not_filled");
    expect(effectiveDetermination({ trigger: "customer_cancel", determination: "filled", conditional_amount: 100 })).toBe("filled");
  });

  it("marley_cancel rows skip the question and refund everything", () => {
    expect(effectiveDetermination({ trigger: "marley_cancel", determination: null, conditional_amount: 100 })).toBe("filled");
  });

  it("nothing conditional means nothing the question could retain", () => {
    expect(effectiveDetermination({ trigger: "customer_cancel", determination: null, conditional_amount: 0 })).toBe("filled");
  });

  it("a conditional customer row without an answer stays undetermined", () => {
    expect(effectiveDetermination({ trigger: "customer_cancel", determination: null, conditional_amount: 100 })).toBeNull();
  });
});

/* ------------------------------------------------------- not-filled gating */

describe("notFilledAllowed (UK day boundary)", () => {
  it("yesterday's date has passed", () => {
    expect(notFilledAllowed("2026-07-21", "2026-07-22")).toBe(true);
  });
  it("TODAY has not passed — the day is still bookable", () => {
    expect(notFilledAllowed("2026-07-22", "2026-07-22")).toBe(false);
  });
  it("a future date has not passed", () => {
    expect(notFilledAllowed("2026-08-14", "2026-07-22")).toBe(false);
  });
  it("no recorded date has nothing to wait for", () => {
    expect(notFilledAllowed(null, "2026-07-22")).toBe(true);
  });
});

/* ------------------------------------------------------------ planForRow */

describe("planForRow — refund/retain maths", () => {
  const prdHeld: HeldPayment[] = [
    held({ amount: 100, at: "2026-07-01T09:00:00Z", label: "deposit" }),
    held({ amount: 350, at: "2026-07-05T09:00:00Z", label: "commitment" }),
  ];

  it("filled refunds everything, retains nothing", () => {
    const { payments, rails } = planForRow(prdHeld, 35000, "filled");
    expect(payments.map((p) => p.refundDuePence)).toEqual([10000, 35000]);
    expect(payments.map((p) => p.retainPence)).toEqual([0, 0]);
    expect(rails[0].refundDuePence).toBe(45000);
  });

  it("not_filled retains the chronological conditional fill, refunds the rest (PRD £1,400 scenario)", () => {
    // 25% cap absorbed £350: the £100 deposit + £250 of the £350 commitment.
    const { payments } = planForRow(prdHeld, 35000, "not_filled");
    expect(payments[0]).toMatchObject({ retainPence: 10000, refundDuePence: 0 });
    expect(payments[1]).toMatchObject({ retainPence: 25000, refundDuePence: 10000 });
  });

  it("conserves every penny: refund + retain === amount, per payment", () => {
    const { payments } = planForRow(
      [held({ amount: 33.33, at: "a" }), held({ amount: 66.67, at: "b", rail: "card" })],
      5000,
      "not_filled",
    );
    for (const p of payments) {
      expect(p.refundDuePence + p.retainPence).toBe(p.amountPence);
      expect(p.conditionalPence + p.unconditionalPence).toBe(p.amountPence);
    }
  });

  it("splits per rail: card and bank money never blend", () => {
    const mixed: HeldPayment[] = [
      held({ rail: "card", amount: 100, at: "2026-07-01T09:00:00Z", label: "card deposit", card_payment_id: "cp-1" }),
      held({ rail: "bank_transfer", amount: 350, at: "2026-07-05T09:00:00Z", label: "commitment" }),
    ];
    const { rails } = planForRow(mixed, 35000, "not_filled");
    const byRail = Object.fromEntries(rails.map((r) => [r.rail, r]));
    expect(byRail.card).toMatchObject({ heldPence: 10000, retainPence: 10000, refundDuePence: 0 });
    expect(byRail.bank_transfer).toMatchObject({ heldPence: 35000, retainPence: 25000, refundDuePence: 10000 });
  });

  it("a zero cap makes everything unconditional (refunds in full even when not filled)", () => {
    const { payments } = planForRow([held({ amount: 100 })], 0, "not_filled");
    expect(payments[0]).toMatchObject({ retainPence: 0, refundDuePence: 10000, unconditionalPence: 10000 });
  });
});

/* ------------------------------------------------------- executed state */

describe("cardExecutedPence — ground truth since the snapshot", () => {
  it("nothing executed on a fresh paid row", () => {
    const state: CardStateIn = { id: "cp-1", status: "paid", amount_pence: 10000, refunded_pence: 0 };
    expect(cardExecutedPence({ amountPence: 10000, refundDuePence: 10000 }, state)).toBe(0);
  });

  it("a refund issued after the snapshot counts", () => {
    const state: CardStateIn = { id: "cp-1", status: "refunded", amount_pence: 10000, refunded_pence: 10000 };
    expect(cardExecutedPence({ amountPence: 10000, refundDuePence: 10000 }, state)).toBe(10000);
  });

  it("refunds that PREDATE the snapshot never count (partial refund before cancel)", () => {
    // £100 card payment, £25 refunded before the cancel → snapshot held £75.
    const plan = { amountPence: 7500, refundDuePence: 7500 };
    const before: CardStateIn = { id: "cp-1", status: "partially_refunded", amount_pence: 10000, refunded_pence: 2500 };
    expect(cardExecutedPence(plan, before)).toBe(0);
    const after: CardStateIn = { ...before, refunded_pence: 10000, status: "refunded" };
    expect(cardExecutedPence(plan, after)).toBe(7500);
  });

  it("clamps at the due amount and handles a missing row", () => {
    const state: CardStateIn = { id: "cp-1", status: "refunded", amount_pence: 10000, refunded_pence: 10000 };
    expect(cardExecutedPence({ amountPence: 10000, refundDuePence: 4000 }, state)).toBe(4000);
    expect(cardExecutedPence({ amountPence: 10000, refundDuePence: 4000 }, null)).toBe(0);
  });
});

describe("executionForPlan", () => {
  const mixedHeld: HeldPayment[] = [
    held({ rail: "card", amount: 100, at: "a", label: "card deposit", card_payment_id: "cp-1" }),
    held({ rail: "bank_transfer", amount: 350, at: "b", label: "commitment" }),
  ];

  it("a recorded bank mark executes the whole rail; card follows the gateway ledger", () => {
    const { rails } = planForRow(mixedHeld, 0, "filled");
    const views = executionForPlan(
      rails,
      new Map([["cp-1", { id: "cp-1", status: "paid", amount_pence: 10000, refunded_pence: 0 }]]),
      new Set<PaymentRail>(["bank_transfer"]),
    );
    const byRail = Object.fromEntries(views.map((r) => [r.rail, r]));
    expect(byRail.card.executed).toBe(false);
    expect(byRail.bank_transfer).toMatchObject({ executed: true, executedPence: 35000 });
    expect(outstandingSummary(views)).toBe("£100.00 by card");
  });

  it("a rail with nothing due counts as executed", () => {
    const { rails } = planForRow([held({ amount: 100 })], 10000, "not_filled");
    const views = executionForPlan(rails, new Map(), new Set());
    expect(views[0]).toMatchObject({ refundDuePence: 0, executed: true });
    expect(outstandingSummary(views)).toBe("");
  });
});

/* ------------------------------------------------------------ sectioning */

describe("sectioning", () => {
  it("routes by status + effective determination", () => {
    expect(sectionFor("pending", null)).toBe("needs_decision");
    expect(sectionFor("pending", "filled")).toBe("to_execute");
    expect(sectionFor("pending", "not_filled")).toBe("to_execute");
    expect(sectionFor("refunded", "filled")).toBe("history");
    expect(sectionFor("retained", "not_filled")).toBe("history");
  });

  it("buildRefundQueueView splits the queue and fills context", () => {
    const v = view([
      row({ id: "a" }), // conditional, unanswered → needs decision
      row({ id: "b", determination: "filled", determined_at: "2026-07-21T10:00:00Z" }),
      row({ id: "c", trigger: "marley_cancel" }), // no question → to execute
      row({ id: "d", conditional_amount: 0, unconditional_amount: 100 }), // unconditional → to execute
      row({ id: "e", status: "refunded", determination: "filled", executed_at: "2026-07-21T12:00:00Z" }),
      row({ id: "f", status: "retained", determination: "not_filled", executed_at: "2026-07-20T12:00:00Z" }),
    ]);
    expect(v.needsDecision.map((i) => i.id)).toEqual(["a"]);
    expect(v.toExecute.map((i) => i.id)).toEqual(["b", "c", "d"]);
    // History newest-settled first.
    expect(v.history.map((i) => i.id)).toEqual(["e", "f"]);
    expect(v.needsDecision[0]).toMatchObject({ customer: "Freddy Arbuthnot", quoteRef: "MMR001", leadId: "l-1" });
  });

  it("falls back to 'Customer' with no quote match", () => {
    const v = view([row({ quote_id: "missing" })]);
    expect(v.needsDecision[0]).toMatchObject({ customer: "Customer", quoteRef: null });
  });

  it("stamps notFilledAllowed from the UK day", () => {
    const passed = view([row({ original_move_date: "2026-07-21" })]);
    const notYet = view([row({ original_move_date: "2026-07-22" })]);
    expect(passed.needsDecision[0].notFilledAllowed).toBe(true);
    expect(notYet.needsDecision[0].notFilledAllowed).toBe(false);
  });
});

/* --------------------------------------------------------------- totals */

describe("totals", () => {
  it("counts pending sections and sums held + outstanding money", () => {
    const v = view([
      row({ id: "a", held: [held({ amount: 100 })], conditional_amount: 100 }),
      row({
        id: "b",
        determination: "not_filled",
        held: [held({ amount: 100 }), held({ amount: 350, at: "2026-07-05T09:00:00Z", label: "commitment" })],
        conditional_amount: 350,
        unconditional_amount: 100,
      }),
      row({ id: "c", status: "refunded", determination: "filled" }),
    ]);
    expect(v.totals).toMatchObject({
      pendingCount: 2,
      needsDecisionCount: 1,
      toExecuteCount: 1,
      heldPendingPence: 55000, // £100 + £450
      outstandingPence: 10000, // only b's unconditional £100 is due out
    });
  });

  it("a not_filled row's display split shows retained vs refunded amounts", () => {
    const v = view([
      row({
        determination: "not_filled",
        held: [held({ amount: 100 }), held({ amount: 350, at: "2026-07-05T09:00:00Z", label: "commitment" })],
        conditional_amount: 350,
        unconditional_amount: 100,
      }),
    ]);
    const item = v.toExecute[0];
    expect(item.retainPence).toBe(35000);
    expect(item.refundDuePence).toBe(10000);
    expect(item.heldPence).toBe(45000);
  });
});
