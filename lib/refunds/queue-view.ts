/**
 * /refunds queue view — the PURE engine (Payments Policy v2, PRD §5D + §8.10).
 * Mirrors lib/payments/received.ts: raw rows in → typed view items + section
 * split + totals out, no IO, fully unit-tested (tests/lib/refund-queue-view.test.ts).
 *
 * Sections:
 *   Needs decision  pending conditional rows still waiting on the one human
 *                   question: "did we re-book <original_move_date>?"
 *   To execute      determined rows + rows that never needed the question
 *                   (marley_cancel, pre-set determinations, zero-conditional) —
 *                   per-rail refund lines with executed state.
 *   History         refunded / retained terminal rows.
 *
 * Executed state is derived from ground truth, never from the snapshot:
 *   card       card_payments.refunded_pence advanced SINCE the snapshot was
 *              taken (the snapshot's held amount tells us where it stood).
 *   bank/cash  an events_log 'rail_refunded' mark on the queue row (the
 *              operator pays out in the bank UI / by hand, then records it).
 *
 * All amounts are integer PENCE in here so a penny can never appear or vanish;
 * everything customer-facing downstream is VAT-inclusive gross. The word
 * "penalty" appears nowhere in any label this module emits.
 */

import {
  PAYMENT_RAILS,
  type FillDetermination,
  type HeldPayment,
  type PaymentRail,
} from "@/lib/payments-policy";

/* ------------------------------------------------------------------ inputs */

/** The refund_queue columns the view needs (raw row shape). */
export interface QueueRowIn {
  id: string;
  created_at: string;
  lead_id: string | null;
  quote_id: string | null;
  original_move_date: string | null;
  trigger: string;
  held: unknown;
  conditional_amount: number;
  unconditional_amount: number;
  determination: string | null;
  determined_by: string | null;
  determined_at: string | null;
  status: string;
  executed_by: string | null;
  executed_at: string | null;
  shortfall_note: string | null;
  cash_recipient_name: string | null;
  cash_recipient_sort: string | null;
  cash_recipient_account: string | null;
  notes: string | null;
}

/** Card ground truth for executed state (card_payments columns). */
export interface CardStateIn {
  id: string;
  status: string;
  amount_pence: number;
  refunded_pence: number;
}

/** A bank/cash payout recorded on the queue row (events_log 'rail_refunded'). */
export interface RailMarkIn {
  queueId: string;
  rail: string;
  amountPence: number;
}

export interface QuoteRefIn {
  quote_ref: string;
  customer_name: string | null;
  lead_id: string | null;
}

/* ------------------------------------------------------------------ labels */

export const TRIGGER_LABELS: Record<string, string> = {
  customer_cancel: "Customer cancelled",
  customer_date_change: "Date change inside 7 days",
  marley_cancel: "Marley cancelled",
};

export const RAIL_LABELS: Record<PaymentRail, string> = {
  card: "Card",
  bank_transfer: "Bank transfer",
  cash: "Cash",
};

/* ------------------------------------------------------------------- money */

const toPence = (n: number | null | undefined): number => Math.round((Number(n) || 0) * 100);

export const gbpPence = (p: number): string =>
  `£${(Math.abs(p) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/* -------------------------------------------------------------- held parse */

const RAIL_SET = new Set<string>(PAYMENT_RAILS);

/**
 * Parse a refund_queue.held jsonb snapshot defensively. Malformed entries and
 * non-positive amounts are skipped (they can't be executed and must never
 * distort the maths); order is normalised chronological (first money in first).
 */
export function parseHeld(value: unknown): HeldPayment[] {
  if (!Array.isArray(value)) return [];
  const out: HeldPayment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const rail = typeof p.rail === "string" && RAIL_SET.has(p.rail) ? (p.rail as PaymentRail) : null;
    const amount = Number(p.amount);
    const at = typeof p.at === "string" && p.at ? p.at : null;
    if (!rail || !at || !Number.isFinite(amount) || amount <= 0) continue;
    out.push({
      rail,
      amount,
      at,
      label: typeof p.label === "string" ? p.label : undefined,
      card_payment_id: typeof p.card_payment_id === "string" ? p.card_payment_id : null,
      zoho_invoice_id: typeof p.zoho_invoice_id === "string" ? p.zoho_invoice_id : null,
      // The 0109 stamp: which ledger minted zoho_invoice_id. A malformed value
      // normalises to null (→ the configured-provider convention) rather than
      // surviving to be mis-read as a provider downstream.
      ledger_provider: typeof p.ledger_provider === "string" ? p.ledger_provider : null,
    });
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/* ---------------------------------------------------------- determinations */

/**
 * The determination that actually governs execution:
 *  - an answered question wins;
 *  - marley_cancel rows never ask it (refund everything);
 *  - a row with nothing conditional has nothing the question could retain, so
 *    it executes as a full refund without waiting for an answer.
 */
export function effectiveDetermination(row: {
  trigger: string;
  determination: string | null;
  conditional_amount: number;
}): FillDetermination | null {
  if (row.determination === "filled" || row.determination === "not_filled") return row.determination;
  if (row.trigger === "marley_cancel") return "filled";
  if (toPence(row.conditional_amount) <= 0) return "filled";
  return null;
}

/**
 * "Not filled" is only answerable once the old date has PASSED in UK
 * wall-clock terms — the day itself still counts as bookable, so strictly
 * before today. A row with no recorded date has nothing to wait for.
 */
export function notFilledAllowed(
  originalMoveDate: string | null | undefined,
  todayUkDay: string,
): boolean {
  if (!originalMoveDate) return true;
  return originalMoveDate < todayUkDay;
}

/* -------------------------------------------------------------------- plan */

export interface PaymentPlan {
  payment: HeldPayment;
  amountPence: number;
  conditionalPence: number;
  unconditionalPence: number;
  refundDuePence: number;
  retainPence: number;
}

export interface RailPlan {
  rail: PaymentRail;
  heldPence: number;
  refundDuePence: number;
  retainPence: number;
  payments: PaymentPlan[];
}

/**
 * Re-derive the per-payment split from the row's FROZEN conditional amount
 * (not a live recompute against the quote — the row is the durable record).
 * The chronological first-in fill against `conditionalPence` reproduces the
 * exact allocation splitHeldMoney made at creation, because the stored
 * conditional_amount is precisely how much of the (chronological) money the
 * 25% cap absorbed. Then the determination decides refund vs retain:
 *   filled     → everything refunds;
 *   not_filled → conditional slices retain, unconditional refunds regardless.
 *
 * TRIGGER-AWARE (PRD §1): a customer_date_change row belongs to a booking that
 * is STILL LIVE — held money "provisionally counts toward the new booking", so
 * NOTHING ever pays out of these rows while the rebooked job stands:
 *   filled     → refund due £0 everywhere (money keeps counting; the row
 *                closes as 'released');
 *   not_filled → the conditional slice is RETAINED (it stops counting toward
 *                the new booking — the shortfall is stated for the balance
 *                invoice) and the unconditional slice keeps counting: refund
 *                due £0 on every rail. If the rebooked job later dies, the
 *                cancel unwind snapshots afresh and THAT row pays out.
 */
export function planForRow(
  held: HeldPayment[],
  conditionalPence: number,
  determination: FillDetermination,
  trigger?: string,
): { payments: PaymentPlan[]; rails: RailPlan[] } {
  const ordered = [...held].sort((a, b) => a.at.localeCompare(b.at));
  let capLeft = Math.max(0, Math.round(conditionalPence));
  const retainConditional = determination === "not_filled";
  const bookingStillLive = trigger === "customer_date_change";

  const payments: PaymentPlan[] = ordered.map((payment) => {
    const amountPence = Math.max(0, toPence(payment.amount));
    const cond = Math.min(capLeft, amountPence);
    capLeft -= cond;
    const uncond = amountPence - cond;
    const retain = retainConditional ? cond : 0;
    return {
      payment,
      amountPence,
      conditionalPence: cond,
      unconditionalPence: uncond,
      refundDuePence: bookingStillLive ? 0 : amountPence - retain,
      retainPence: retain,
    };
  });

  const rails: RailPlan[] = [];
  for (const rail of PAYMENT_RAILS) {
    const mine = payments.filter((p) => p.payment.rail === rail);
    if (!mine.length) continue;
    rails.push({
      rail,
      heldPence: mine.reduce((s, p) => s + p.amountPence, 0),
      refundDuePence: mine.reduce((s, p) => s + p.refundDuePence, 0),
      retainPence: mine.reduce((s, p) => s + p.retainPence, 0),
      payments: mine,
    });
  }
  return { payments, rails };
}

/**
 * The pence a not_filled decision retains for a row (the chronological
 * conditional fill) — shared by the retain action and, for date-change
 * forfeits, by the balance-invoice flow (which must stop crediting money
 * that no longer counts toward the rebooked job).
 */
export function retainedPenceFor(held: HeldPayment[], conditionalPence: number): number {
  const { payments } = planForRow(held, conditionalPence, "not_filled");
  return payments.reduce((s, p) => s + p.retainPence, 0);
}

/* --------------------------------------------------------------- execution */

export interface PaymentView {
  key: string;
  rail: PaymentRail;
  label: string;
  at: string;
  amountPence: number;
  refundDuePence: number;
  retainPence: number;
  executedPence: number;
  executed: boolean;
  cardPaymentId: string | null;
  zohoInvoiceId: string | null;
  /** Which ledger minted `zohoInvoiceId` (0109) — the reversal loop routes
   *  each step by THIS, never by a sibling payment's stamp. */
  ledgerProvider: string | null;
}

export interface RailView {
  rail: PaymentRail;
  heldPence: number;
  refundDuePence: number;
  retainPence: number;
  executedPence: number;
  executed: boolean;
  payments: PaymentView[];
}

/**
 * How much of a card payment's due refund has ACTUALLY been executed since the
 * snapshot. The snapshot's held amount = amount_pence − refunded_pence at
 * snapshot time, so refunds issued since = refunded_pence(now) − (amount_pence
 * − heldAtSnapshot), clamped at 0 (a snapshot that predates data repair can
 * never yield negative execution).
 */
export function cardExecutedPence(
  plan: Pick<PaymentPlan, "amountPence" | "refundDuePence">,
  state: CardStateIn | null | undefined,
): number {
  if (!state) return 0;
  // `refunded_pence` is advanced as a RESERVATION before the gateway is called
  // (card-payments.ts reserves, then calls REFUND_SALE), and on an ambiguous
  // outcome the row is frozen at 'needs_review' with the reservation intact —
  // deliberately, so nobody retries a refund that may have gone through. Reading
  // executed-ness from the pence alone therefore reported an UNCONFIRMED refund
  // as done: the rail showed "£X refunded · £0 outstanding", the queue row could
  // be completed, and the customer was emailed "your refund has been issued" for
  // money that may never have left. Only a settled row counts as executed.
  if (state.status === "needs_review") return 0;
  const refundedAtSnapshot = Math.max(0, state.amount_pence - plan.amountPence);
  const newRefunds = Math.max(0, state.refunded_pence - refundedAtSnapshot);
  return Math.min(plan.refundDuePence, newRefunds);
}

/**
 * Attach executed state to a plan. Bank/cash rails execute as a whole (one
 * payout, one recorded mark); card executes per payment against the gateway
 * ledger. A rail with nothing due to refund counts as executed by definition.
 */
export function executionForPlan(
  rails: RailPlan[],
  cardStatesById: Map<string, CardStateIn>,
  markedRails: Set<PaymentRail>,
): RailView[] {
  return rails.map((rail) => {
    const payments: PaymentView[] = rail.payments.map((p, i) => {
      let executedPence = 0;
      if (rail.rail === "card") {
        executedPence = cardExecutedPence(p, p.payment.card_payment_id ? cardStatesById.get(p.payment.card_payment_id) : null);
      } else if (markedRails.has(rail.rail)) {
        executedPence = p.refundDuePence;
      }
      return {
        key: p.payment.card_payment_id ?? `${rail.rail}:${p.payment.at}:${i}`,
        rail: rail.rail,
        label: p.payment.label ?? rail.rail.replace("_", " "),
        at: p.payment.at,
        amountPence: p.amountPence,
        refundDuePence: p.refundDuePence,
        retainPence: p.retainPence,
        executedPence,
        executed: executedPence >= p.refundDuePence,
        cardPaymentId: p.payment.card_payment_id ?? null,
        zohoInvoiceId: p.payment.zoho_invoice_id ?? null,
        ledgerProvider: p.payment.ledger_provider ?? null,
      };
    });
    const executedPence = payments.reduce((s, p) => s + p.executedPence, 0);
    return {
      rail: rail.rail,
      heldPence: rail.heldPence,
      refundDuePence: rail.refundDuePence,
      retainPence: rail.retainPence,
      executedPence,
      executed: payments.every((p) => p.executed),
      payments,
    };
  });
}

/** Human summary of what still needs paying out, for action errors + UI hints. */
export function outstandingSummary(rails: RailView[]): string {
  const bits = rails
    .filter((r) => r.refundDuePence > r.executedPence)
    .map((r) => `${gbpPence(r.refundDuePence - r.executedPence)} by ${RAIL_LABELS[r.rail].toLowerCase()}`);
  return bits.join(", ");
}

/* -------------------------------------------------------------- view items */

export type QueueSection = "needs_decision" | "to_execute" | "history";

export function sectionFor(status: string, effective: FillDetermination | null): QueueSection {
  if (status !== "pending") return "history";
  return effective === null ? "needs_decision" : "to_execute";
}

export interface QueueItemView {
  id: string;
  createdAt: string;
  status: string;
  trigger: string;
  triggerLabel: string;
  customer: string;
  quoteRef: string | null;
  leadId: string | null;
  originalMoveDate: string | null;
  determination: FillDetermination | null;
  effective: FillDetermination | null;
  determinedBy: string | null;
  determinedAt: string | null;
  executedBy: string | null;
  executedAt: string | null;
  heldPence: number;
  conditionalPence: number;
  unconditionalPence: number;
  refundDuePence: number;
  retainPence: number;
  outstandingPence: number;
  rails: RailView[];
  allExecuted: boolean;
  notFilledAllowed: boolean;
  cashRecipient: { name: string; sort: string; account: string } | null;
  shortfallNote: string | null;
  notes: string | null;
}

export interface RefundQueueView {
  needsDecision: QueueItemView[];
  toExecute: QueueItemView[];
  history: QueueItemView[];
  totals: {
    pendingCount: number;
    needsDecisionCount: number;
    toExecuteCount: number;
    /** Everything held on pending rows. */
    heldPendingPence: number;
    /** Refunds still awaiting execution across the To-execute section. */
    outstandingPence: number;
  };
}

export interface QueueViewInput {
  rows: QueueRowIn[];
  quotesById: Map<string, QuoteRefIn>;
  cardStatesById: Map<string, CardStateIn>;
  railMarks: RailMarkIn[];
  /** Today's UK calendar day (yyyy-mm-dd) — gates the "Not filled" answer. */
  todayUkDay: string;
}

const asDetermination = (v: string | null): FillDetermination | null =>
  v === "filled" || v === "not_filled" ? v : null;

export function buildRefundQueueView(input: QueueViewInput): RefundQueueView {
  const marksByQueue = new Map<string, Set<PaymentRail>>();
  for (const mark of input.railMarks) {
    if (!RAIL_SET.has(mark.rail)) continue;
    const set = marksByQueue.get(mark.queueId) ?? new Set<PaymentRail>();
    set.add(mark.rail as PaymentRail);
    marksByQueue.set(mark.queueId, set);
  }

  const needsDecision: QueueItemView[] = [];
  const toExecute: QueueItemView[] = [];
  const history: QueueItemView[] = [];

  for (const row of input.rows) {
    const held = parseHeld(row.held);
    const effective = effectiveDetermination(row);
    const conditionalPence = toPence(row.conditional_amount);
    const unconditionalPence = toPence(row.unconditional_amount);
    // Needs-decision rows have no governing determination yet; plan under
    // "filled" purely so the per-rail held display exists (nothing executes
    // from that section).
    const planDet: FillDetermination = effective ?? "filled";
    const { rails } = planForRow(held, conditionalPence, planDet, row.trigger);
    const railViews = executionForPlan(
      rails,
      input.cardStatesById,
      marksByQueue.get(row.id) ?? new Set<PaymentRail>(),
    );

    const heldPence = railViews.reduce((s, r) => s + r.heldPence, 0);
    const refundDuePence = railViews.reduce((s, r) => s + r.refundDuePence, 0);
    const retainPence = railViews.reduce((s, r) => s + r.retainPence, 0);
    const outstandingPence = railViews.reduce(
      (s, r) => s + Math.max(0, r.refundDuePence - r.executedPence),
      0,
    );
    const quote = row.quote_id ? (input.quotesById.get(row.quote_id) ?? null) : null;
    const cashRecipient =
      row.cash_recipient_name && row.cash_recipient_sort && row.cash_recipient_account
        ? {
            name: row.cash_recipient_name,
            sort: row.cash_recipient_sort,
            account: row.cash_recipient_account,
          }
        : null;

    const item: QueueItemView = {
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      trigger: row.trigger,
      triggerLabel: TRIGGER_LABELS[row.trigger] ?? row.trigger,
      customer: quote?.customer_name || "Customer",
      quoteRef: quote?.quote_ref ?? null,
      leadId: row.lead_id ?? quote?.lead_id ?? null,
      originalMoveDate: row.original_move_date,
      determination: asDetermination(row.determination),
      effective,
      determinedBy: row.determined_by,
      determinedAt: row.determined_at,
      executedBy: row.executed_by,
      executedAt: row.executed_at,
      heldPence,
      conditionalPence,
      unconditionalPence,
      refundDuePence,
      retainPence,
      outstandingPence,
      rails: railViews,
      allExecuted: railViews.every((r) => r.executed),
      notFilledAllowed: notFilledAllowed(row.original_move_date, input.todayUkDay),
      cashRecipient,
      shortfallNote: row.shortfall_note,
      notes: row.notes,
    };

    const section = sectionFor(row.status, effective);
    if (section === "needs_decision") needsDecision.push(item);
    else if (section === "to_execute") toExecute.push(item);
    else history.push(item);
  }

  // Pending first-in-first-served (oldest first — the queue is a to-do list);
  // history newest first (it's a record).
  needsDecision.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  toExecute.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  history.sort(
    (a, b) => (b.executedAt ?? b.createdAt).localeCompare(a.executedAt ?? a.createdAt),
  );

  const pending = [...needsDecision, ...toExecute];
  return {
    needsDecision,
    toExecute,
    history,
    totals: {
      pendingCount: pending.length,
      needsDecisionCount: needsDecision.length,
      toExecuteCount: toExecute.length,
      heldPendingPence: pending.reduce((s, i) => s + i.heldPence, 0),
      outstandingPence: toExecute.reduce((s, i) => s + i.outstandingPence, 0),
    },
  };
}
