/**
 * Storage billing period engine — PURE date/money math (the cron, the release
 * flow and the UI all call this; tests walk it). Two models, routed by
 * billing_model (docs/storage-billing-v2-prd.md):
 *
 *  'period' (containers/rooms — the 2026-07-10 model, unchanged):
 *  - Invoices are raised IN ADVANCE, one per rate period (weekly = every 7
 *    days from start_date; monthly = same day-of-month, clamped for short
 *    months). A period is due once its start day arrives.
 *  - NO pro-rata on release: the period containing end_date is billed in
 *    full; periods starting after end_date never bill. (Standard
 *    self-storage practice; the agreement says so.)
 *
 *  'crate_daily' (Sandys crates — standing policy, 2026-07-22):
 *  - 28-day minimum invoiced UPFRONT at commencement (min_amount frozen on
 *    the let); early release still pays it in full and owes no day charges
 *    inside the window.
 *  - Day 29+ charged to the EXACT day, IN ARREARS, on a 28-day cycle: each
 *    window bills the day after it completes — or immediately once end_date
 *    is set (release settlement: all charges settled before goods leave;
 *    the departure day itself is chargeable).
 *  - Handling events (in/out/access, amount frozen at record time) ride the
 *    invoice whose period_end covers their date — deterministic, so a
 *    crash-retry recomputes the same sweep and Zoho orphan adoption stays
 *    amount-consistent. A release that leaves events with no due period
 *    (e.g. egress inside the minimum window) raises a handling-only 'final'
 *    invoice claimed at end_date+1 (no cycle can ever start there).
 *
 *  Both: billing_paused or a missing/zero rate = nothing raised; backfill is
 *  capped per run (safety against a forgotten old let) — the cron logs skips.
 */

export interface BillableLet {
  id: string;
  start_date: string; // yyyy-mm-dd
  end_date: string | null;
  rate: number | null;
  rate_period: string; // 'week' | 'month' | 'day' (day = crate_daily lets)
  billing_paused: boolean;
  billing_model?: string | null; // 'period' (default) | 'crate_daily'
  min_days?: number | null; // crate_daily: minimum-stay days (frozen at creation)
  min_amount?: number | null; // crate_daily: minimum-stay charge, VAT-inclusive
}

export interface HandlingEventLite {
  id: string;
  event_date: string; // yyyy-mm-dd
  kind: string; // 'in' | 'out' | 'access'
  amount: number;
}

export interface DueInvoice {
  period_start: string;
  period_end: string; // inclusive last day
  kind: "period" | "minimum" | "arrears" | "final";
  /** Total to invoice = usageAmount + handlingAmount. */
  amount: number;
  /** The stay charge: period rate / minimum / days × day rate. */
  usageAmount: number;
  handlingAmount: number;
  handlingEvents: HandlingEventLite[];
  /** Chargeable days covered (crate models; 0 for handling-only). */
  days: number;
}

export interface BillingPeriod {
  period_start: string; // yyyy-mm-dd
  period_end: string; // inclusive last day
  amount: number;
}

export const MAX_PERIODS_PER_RUN = 12;

const d = (iso: string): Date => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
const iso = (t: Date): string => t.toISOString().slice(0, 10);

/** The next period start after `startIso`, anchored to the let's own
 *  anniversary. Monthly clamps: a let starting the 31st bills on the 28th/29th
 *  in February and the 30th in 30-day months, staying on the 31st elsewhere. */
export function nextPeriodStart(startIso: string, anchorIso: string, period: string): string {
  if (period === "week") {
    const t = d(startIso);
    t.setUTCDate(t.getUTCDate() + 7);
    return iso(t);
  }
  // month: advance by whole months from the ANCHOR (not the possibly-clamped
  // current start) so a 31st anchor recovers to the 31st after February.
  const anchor = d(anchorIso);
  const cur = d(startIso);
  const monthsSinceAnchor =
    (cur.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (cur.getUTCMonth() - anchor.getUTCMonth()) + 1;
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + monthsSinceAnchor;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(anchor.getUTCDate(), lastDay);
  return iso(new Date(Date.UTC(y, m, day)));
}

/** Inclusive last day of a period that starts at `startIso`. */
export function periodEnd(startIso: string, anchorIso: string, period: string): string {
  const next = d(nextPeriodStart(startIso, anchorIso, period));
  next.setUTCDate(next.getUTCDate() - 1);
  return iso(next);
}

/**
 * Which periods are due (start day reached, not already invoiced) for a let?
 * `existingStarts` = period_start values already claimed in storage_invoices.
 */
export function periodsDue(let_: BillableLet, existingStarts: Set<string>, todayIso: string): BillingPeriod[] {
  const rate = Number(let_.rate ?? 0);
  if (!rate || rate <= 0 || let_.billing_paused) return [];
  const out: BillingPeriod[] = [];
  let cursor = let_.start_date.slice(0, 10);
  const today = todayIso.slice(0, 10);
  const end = let_.end_date?.slice(0, 10) ?? null;
  let guard = 0;
  while (cursor <= today && (!end || cursor <= end) && guard < 500) {
    guard++;
    if (!existingStarts.has(cursor)) {
      out.push({
        period_start: cursor,
        period_end: periodEnd(cursor, let_.start_date, let_.rate_period),
        amount: Math.round(rate * 100) / 100,
      });
      if (out.length >= MAX_PERIODS_PER_RUN) break;
    }
    cursor = nextPeriodStart(cursor, let_.start_date, let_.rate_period);
  }
  return out;
}

/** The next date a new invoice will be raised for an OPEN let (UI hint), or
 *  null when billing is off/paused. Assumes all due periods are invoiced. */
export function nextInvoiceDate(let_: BillableLet, existingStarts: Set<string>, todayIso: string): string | null {
  const rate = Number(let_.rate ?? 0);
  if (!rate || rate <= 0 || let_.billing_paused || let_.end_date) return null;
  let cursor = let_.start_date.slice(0, 10);
  let guard = 0;
  while (guard < 500) {
    guard++;
    if (cursor > todayIso.slice(0, 10)) return cursor; // first future period
    if (!existingStarts.has(cursor)) return cursor; // overdue-to-raise (cron will catch up)
    cursor = nextPeriodStart(cursor, let_.start_date, let_.rate_period);
  }
  return null;
}

/** Zoho reference for a period — the adoption half of never-create-twice. */
export function storageInvoiceReference(letId: string, periodStart: string): string {
  return `MMS-${letId.slice(0, 8)}-${periodStart}`;
}

/* ------------------------------------------------------------ crate_daily */

const r2 = (n: number): number => Math.round(n * 100) / 100;

const addDays = (isoDay: string, n: number): string => {
  const t = d(isoDay);
  t.setUTCDate(t.getUTCDate() + n);
  return iso(t);
};

/** Inclusive day count from a to b (a ≤ b). */
const daysInclusive = (a: string, b: string): number =>
  Math.round((d(b).getTime() - d(a).getTime()) / 86_400_000) + 1;

export const CRATE_CYCLE_DAYS = 28;

function isCrateDaily(let_: BillableLet): boolean {
  return let_.billing_model === "crate_daily";
}

/**
 * Due invoices for a crate_daily let. `events` must be the let's UNBILLED
 * handling events (billed_invoice_id null) — each is swept, in date order,
 * onto the first due invoice whose period_end covers its date.
 */
export function crateInvoicesDue(
  let_: BillableLet,
  existingStarts: Set<string>,
  events: HandlingEventLite[],
  todayIso: string,
): DueInvoice[] {
  const rate = Number(let_.rate ?? 0);
  if (!rate || rate <= 0 || let_.billing_paused) return [];
  const minDays = Math.max(1, Math.trunc(Number(let_.min_days ?? 0)) || CRATE_CYCLE_DAYS);
  const minAmount = r2(Number(let_.min_amount ?? 0));
  const start = let_.start_date.slice(0, 10);
  const today = todayIso.slice(0, 10);
  const end = let_.end_date?.slice(0, 10) ?? null;

  const pool = [...events].sort((a, b) => a.event_date.localeCompare(b.event_date));
  const used = new Set<string>();
  const sweep = (throughIso: string): { list: HandlingEventLite[]; amount: number } => {
    const list: HandlingEventLite[] = [];
    let amount = 0;
    for (const e of pool) {
      if (used.has(e.id) || e.event_date.slice(0, 10) > throughIso) continue;
      used.add(e.id);
      list.push(e);
      amount += Number(e.amount) || 0;
    }
    return { list, amount: r2(amount) };
  };

  const out: DueInvoice[] = [];
  const minEnd = addDays(start, minDays - 1);

  // 1) The minimum — in advance, due from commencement day. Never truncated
  //    by end_date (early release still pays it; days inside are covered).
  if (start <= today && !existingStarts.has(start)) {
    const h = sweep(minEnd);
    out.push({
      period_start: start,
      period_end: minEnd,
      kind: "minimum",
      usageAmount: minAmount,
      handlingAmount: h.amount,
      handlingEvents: h.list,
      amount: r2(minAmount + h.amount),
      days: minDays,
    });
  }

  // 2) Arrears cycles from start+minDays: each 28-day window bills the day
  //    after it completes; a set end_date makes the truncated remainder due
  //    IMMEDIATELY (release settlement) and stops cycles after departure.
  let cursor = addDays(start, minDays);
  let guard = 0;
  while (guard < 500 && out.length < MAX_PERIODS_PER_RUN) {
    guard++;
    if (end && cursor > end) break;
    const cycleEnd = addDays(cursor, CRATE_CYCLE_DAYS - 1);
    const effEnd = end && end < cycleEnd ? end : cycleEnd;
    const due = end != null || today > effEnd;
    if (!due) break;
    if (!existingStarts.has(cursor)) {
      const days = daysInclusive(cursor, effEnd);
      const usage = r2(days * rate);
      const h = sweep(effEnd);
      out.push({
        period_start: cursor,
        period_end: effEnd,
        kind: end && effEnd === end ? "final" : "arrears",
        usageAmount: usage,
        handlingAmount: h.amount,
        handlingEvents: h.list,
        amount: r2(usage + h.amount),
        days,
      });
    }
    if (end && cycleEnd >= end) break;
    cursor = addDays(cycleEnd, 1);
  }

  // 3) Handling-only settlement: released, no due period carried the events
  //    (e.g. egress inside the minimum window after the minimum billed).
  //    Claimed at end_date+1 — no cycle or minimum can ever start there.
  if (end && out.length < MAX_PERIODS_PER_RUN) {
    const h = sweep(end);
    if (h.list.length) {
      const claim = addDays(end, 1);
      if (!existingStarts.has(claim)) {
        out.push({
          period_start: claim,
          period_end: claim,
          kind: "final",
          usageAmount: 0,
          handlingAmount: h.amount,
          handlingEvents: h.list,
          amount: h.amount,
          days: 0,
        });
      }
    }
  }
  return out;
}

/**
 * Unified router — period lets return their in-advance periods as DueInvoice
 * rows (kind 'period', no handling); crate lets run the daily-arrears model.
 */
export function invoicesDue(
  let_: BillableLet,
  existingStarts: Set<string>,
  events: HandlingEventLite[],
  todayIso: string,
): DueInvoice[] {
  if (isCrateDaily(let_)) return crateInvoicesDue(let_, existingStarts, events, todayIso);
  return periodsDue(let_, existingStarts, todayIso).map((p) => ({
    period_start: p.period_start,
    period_end: p.period_end,
    kind: "period" as const,
    amount: p.amount,
    usageAmount: p.amount,
    handlingAmount: 0,
    handlingEvents: [],
    days: daysInclusive(p.period_start, p.period_end),
  }));
}

/** Next raise date for an OPEN crate let (UI hint): the minimum on the start
 *  day, then the day after each 28-day window completes. */
export function crateNextInvoiceDate(
  let_: BillableLet,
  existingStarts: Set<string>,
  _todayIso: string,
): string | null {
  const rate = Number(let_.rate ?? 0);
  if (!rate || rate <= 0 || let_.billing_paused || let_.end_date) return null;
  const minDays = Math.max(1, Math.trunc(Number(let_.min_days ?? 0)) || CRATE_CYCLE_DAYS);
  const start = let_.start_date.slice(0, 10);
  if (!existingStarts.has(start)) return start; // minimum due at commencement
  let cursor = addDays(start, minDays);
  let guard = 0;
  while (guard < 500) {
    guard++;
    if (!existingStarts.has(cursor)) return addDays(cursor, CRATE_CYCLE_DAYS); // raise day = window end + 1
    cursor = addDays(cursor, CRATE_CYCLE_DAYS);
  }
  return null;
}

/** Router for the UI "next invoice" chip. */
export function nextInvoiceDateFor(
  let_: BillableLet,
  existingStarts: Set<string>,
  todayIso: string,
): string | null {
  if (isCrateDaily(let_)) return crateNextInvoiceDate(let_, existingStarts, todayIso);
  return nextInvoiceDate(let_, existingStarts, todayIso);
}
