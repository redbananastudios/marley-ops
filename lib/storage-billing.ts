/**
 * Storage billing period engine — PURE date/money math (the cron and the UI
 * both call this; tests walk it). Billing model decided 2026-07-10:
 *
 *  - Invoices are raised IN ADVANCE, one per rate period (weekly = every 7
 *    days from start_date; monthly = same day-of-month, clamped for short
 *    months). A period is due once its start day arrives.
 *  - NO pro-rata on release: the period containing end_date is billed in
 *    full; periods starting after end_date never bill. (Standard
 *    self-storage practice; the agreement says so.)
 *  - billing_paused or a missing/zero rate = nothing raised.
 *  - Backfill is capped per run (safety against a forgotten old let) — the
 *    cron logs what it skipped.
 */

export interface BillableLet {
  id: string;
  start_date: string; // yyyy-mm-dd
  end_date: string | null;
  rate: number | null;
  rate_period: string; // 'week' | 'month'
  billing_paused: boolean;
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
