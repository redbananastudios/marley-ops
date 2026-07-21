/**
 * Payments Policy v2 — the pure policy engine (docs/payments-policy-v2-prd.md,
 * locked with Peter + Connor 21 Jul 2026). No IO — fully unit-tested in
 * tests/lib/payments-policy.test.ts.
 *
 * The ladder in one breath: deposit refundable until the customer confirms
 * their move date; confirmation raises a commitment invoice (25% of gross
 * minus the deposit) due move−7d; cancels / inside-window changes hold what's
 * been paid capped at 25% of gross, decided by one human question — did the
 * old day re-book?
 *
 * Day maths is UK wall-clock throughout (ukDayOf — never raw UTC day
 * arithmetic): the calendar-day distance to a move is what the customer was
 * told, and a 23:30 UTC summer instant is already "tomorrow" in the UK.
 *
 * Copy rule carried by everything downstream of these numbers: the word
 * "penalty" NEVER appears in customer-facing output — held money is "held
 * against your original date — refunded in full if we re-book it."
 */

import { ukDayOf } from "@/lib/sales-report";
import { round2 } from "@/lib/quote/payments";

/* -------------------------------------------------------------- constants */

/** Committed share of the VAT-inclusive agreed price once the date is confirmed. */
export const COMMITMENT_PCT = 0.25;

/** Commitment falls due this many days before the move (and the change window
 *  is the same width: strictly closer than this = inside). */
export const COMMITMENT_DUE_DAYS_BEFORE = 7;

/** T-10 human call task: confirm the date / chase the commitment. */
export const CONFIRM_CALL_DAYS_BEFORE = 10;

/** Customer-stated refund SLA (working assumption used in refund emails). */
export const REFUND_CUSTOMER_SLA_DAYS = 14;

/* -------------------------------------------------------- UK day plumbing */

const DAY_MS = 24 * 60 * 60 * 1000;

/** yyyy-mm-dd → UTC-midnight ms (calendar arithmetic only — date strings have
 *  no wall-clock component, so UTC maths on them is DST-safe). */
function dayToMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

const msToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The UK calendar day containing `at`. */
function ukToday(at: Date): string {
  // A valid Date always yields a day; the fallback guards NaN dates in tests.
  return ukDayOf(at.toISOString()) ?? new Date().toISOString().slice(0, 10);
}

/** Whole UK-calendar days from `fromDay` to `toDay` (negative = past). */
function diffDays(fromDay: string, toDay: string): number | null {
  const a = dayToMs(fromDay);
  const b = dayToMs(toDay);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/* -------------------------------------------------------------- the maths */

/**
 * Commitment invoice amount: 25% of the gross agreed price minus the ACTUAL
 * deposit on the quote (office can override the £100 default — never assume a
 * constant). Zero-commitment suppression falls out of the clamp: when
 * 25%×gross ≤ deposit there is nothing to invoice (confirmation still flips
 * non-refundability — that's the caller's job).
 */
export function commitmentAmount(grossAgreed: number, depositAmount: number): number {
  return round2(Math.max(0, COMMITMENT_PCT * (grossAgreed || 0) - (depositAmount || 0)));
}

/**
 * When the commitment falls due (yyyy-mm-dd): move − 7 UK-calendar days,
 * clamped to today's UK day when confirmation happens later than that (late
 * collapse — due immediately). A missing/invalid move date also collapses to
 * today: with no date to anchor to, "due now" is the only honest answer.
 */
export function commitmentDueDate(
  movingDate: string | null | undefined,
  today: Date = new Date(),
): string {
  const todayDay = ukToday(today);
  const moveDay = ukDayOf(movingDate ?? null);
  const moveMs = moveDay ? dayToMs(moveDay) : null;
  if (moveMs === null) return todayDay;
  const due = msToDay(moveMs - COMMITMENT_DUE_DAYS_BEFORE * DAY_MS);
  return due < todayDay ? todayDay : due;
}

/**
 * Inside the change window ⇔ strictly fewer than 7 UK-calendar days until the
 * move. Boundary rule (test-locked both sides): exactly 7 days out = OUTSIDE
 * (free change); 6 days out = inside. Past or same-day moves are inside. A
 * missing move date has no window to be inside (callers guard upstream).
 */
export function isInsideChangeWindow(
  movingDate: string | null | undefined,
  today: Date = new Date(),
): boolean {
  const moveDay = ukDayOf(movingDate ?? null);
  if (!moveDay) return false;
  const days = diffDays(ukToday(today), moveDay);
  if (days === null) return false;
  return days < COMMITMENT_DUE_DAYS_BEFORE;
}

/* ------------------------------------------------------------- held money */

export type PaymentRail = "card" | "bank_transfer" | "cash";

export const PAYMENT_RAILS: readonly PaymentRail[] = ["card", "bank_transfer", "cash"];

/**
 * One held payment inside a refund_queue `held` snapshot. Amounts are GBP
 * gross (what the customer actually paid — VAT questions live in Zoho).
 * `at` is the chronological key (ISO instant, or yyyy-mm-dd) — first money
 * in is first money held.
 */
export interface HeldPayment {
  rail: PaymentRail;
  amount: number;
  at: string;
  /** Display tag: "deposit" | "commitment" | "balance" | "card payment"… */
  label?: string;
  card_payment_id?: string | null;
  zoho_invoice_id?: string | null;
}

export interface HeldAllocation {
  payment: HeldPayment;
  /** Slice retained only if the old day stays empty. */
  conditional: number;
  /** Slice refunded regardless of fill (above the 25% cap). */
  unconditional: number;
}

export interface RailTotals {
  conditional: number;
  unconditional: number;
  total: number;
}

export interface HeldSplit {
  /** The retention ceiling: 25% × gross agreed. */
  cap: number;
  conditional: number;
  unconditional: number;
  total: number;
  /** Per payment, in chronological order — lets the queue show
   *  "£100 card + £250 of £350 bank held; £100 bank unconditional". */
  allocations: HeldAllocation[];
  byRail: Record<PaymentRail, RailTotals>;
}

const toPence = (n: number): number => Math.round((Number(n) || 0) * 100);
const toPounds = (p: number): number => p / 100;

const emptyRailTotals = (): Record<PaymentRail, RailTotals> => ({
  card: { conditional: 0, unconditional: 0, total: 0 },
  bank_transfer: { conditional: 0, unconditional: 0, total: 0 },
  cash: { conditional: 0, unconditional: 0, total: 0 },
});

/**
 * Split everything held into conditional (retainable, capped at 25% of gross)
 * vs unconditional (always refunded) — chronological first-in fills the cap.
 * Allocation runs in integer pence so a penny can never appear or vanish:
 * per payment, conditional + unconditional === amount, exactly.
 */
export function splitHeldMoney(payments: HeldPayment[], grossAgreed: number): HeldSplit {
  const capPence = Math.max(0, Math.round(COMMITMENT_PCT * toPence(grossAgreed)));
  const ordered = [...payments].sort((a, b) => a.at.localeCompare(b.at));

  const allocations: HeldAllocation[] = [];
  const byRail = emptyRailTotals();
  let capLeft = capPence;
  let conditional = 0;
  let unconditional = 0;

  for (const payment of ordered) {
    const amount = Math.max(0, toPence(payment.amount));
    const cond = Math.min(capLeft, amount);
    const uncond = amount - cond;
    capLeft -= cond;
    conditional += cond;
    unconditional += uncond;
    allocations.push({
      payment,
      conditional: toPounds(cond),
      unconditional: toPounds(uncond),
    });
    const rail = byRail[payment.rail];
    rail.conditional = toPounds(toPence(rail.conditional) + cond);
    rail.unconditional = toPounds(toPence(rail.unconditional) + uncond);
    rail.total = toPounds(toPence(rail.total) + amount);
  }

  return {
    cap: toPounds(capPence),
    conditional: toPounds(conditional),
    unconditional: toPounds(unconditional),
    total: toPounds(conditional + unconditional),
    allocations,
    byRail,
  };
}

/* ---------------------------------------------------------------- outcome */

/** The one human answer on a conditional row: did the old day re-book? */
export type FillDetermination = "filled" | "not_filled";

export interface RefundOutcome {
  refundTotal: number;
  retainTotal: number;
  byRail: Record<PaymentRail, { refund: number; retain: number }>;
  /** Chronological, mirroring split.allocations. */
  perPayment: { payment: HeldPayment; refund: number; retain: number }[];
}

/**
 * What actually moves per rail once the fill question is answered:
 *  - filled     → everything refunded (also the marley-cancel treatment —
 *                 callers pass "filled" for rows that skip the question).
 *  - not_filled → the conditional slice is retained, the unconditional slice
 *                 refunds regardless.
 * Refunds return via the ORIGINAL rail — the per-rail shape here is what the
 * /refunds page executes from.
 */
export function refundOutcome(determination: FillDetermination, split: HeldSplit): RefundOutcome {
  const retainConditional = determination === "not_filled";
  const byRailPence: Record<PaymentRail, { refund: number; retain: number }> = {
    card: { refund: 0, retain: 0 },
    bank_transfer: { refund: 0, retain: 0 },
    cash: { refund: 0, retain: 0 },
  };

  let refundPence = 0;
  let retainPence = 0;
  const perPayment = split.allocations.map(({ payment, conditional, unconditional }) => {
    const retain = retainConditional ? toPence(conditional) : 0;
    const refund = toPence(conditional) + toPence(unconditional) - retain;
    refundPence += refund;
    retainPence += retain;
    byRailPence[payment.rail].refund += refund;
    byRailPence[payment.rail].retain += retain;
    return { payment, refund: toPounds(refund), retain: toPounds(retain) };
  });

  const byRail = {
    card: { refund: toPounds(byRailPence.card.refund), retain: toPounds(byRailPence.card.retain) },
    bank_transfer: {
      refund: toPounds(byRailPence.bank_transfer.refund),
      retain: toPounds(byRailPence.bank_transfer.retain),
    },
    cash: { refund: toPounds(byRailPence.cash.refund), retain: toPounds(byRailPence.cash.retain) },
  };

  return {
    refundTotal: toPounds(refundPence),
    retainTotal: toPounds(retainPence),
    byRail,
    perPayment,
  };
}
