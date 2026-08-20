/**
 * Bookings money/action queue — the pure bucket classifier behind
 * app/(dashboard)/bookings (schedule-allocation-design.md §"Bookings page →
 * money/action queue"). One row lands in exactly ONE bucket, ordered by the
 * money lifecycle, so the page reads as "who do I need to act on today":
 *
 *   deposit_outstanding  accepted, £100 unpaid (auto-chased d1/d3)
 *   no_date              paid the £100, nothing pencilled at all
 *   provisional          paid the £100, window/provisional date pencilled
 *   commitment_overdue   booked; 25% past its due date or date-at-risk flagged
 *   commitment_due       booked; 25% invoiced and not yet paid
 *   balance_overdue      move day has passed with balance unpaid (money at risk)
 *   balance_due          balance invoiced, or move within the invoice window
 *   all_set              booked, nothing owed right now
 *
 * Allocation ("confirmed, not allocated") is deliberately a FLAG, not a bucket:
 * it is orthogonal to money, so it renders as a chip + a headline count instead
 * of pulling rows out of money order.
 */

export type BookingBucket =
  | "deposit_outstanding"
  | "no_date"
  | "provisional"
  | "commitment_overdue"
  | "commitment_due"
  | "balance_overdue"
  | "balance_due"
  | "all_set";

export interface QueueSignals {
  depositPaidAt: string | null;
  /** A scheduled/completed removal appointment exists (the diary is factual). */
  hasRemovalAppt: boolean;
  /** UK calendar day (yyyy-mm-dd) of the removal slot, when booked. */
  apptDayUk: string | null;
  provisionalDate: string | null;
  approxWindow: string | null;
  approxMonth: string | null;
  commitmentPaidAt: string | null;
  /** Frozen 25% invoice amount — null/0 = nothing on the ladder yet. */
  commitmentInvoiceAmount: number | null;
  commitmentDueDate: string | null; // yyyy-mm-dd
  /** T-7 date-at-risk flag (chase engine) — always OVERDUE when set. */
  dateReleasableAt: string | null;
  balancePaidAt: string | null;
  balanceInvoiceNumber: string | null;
}

/** Days from `todayUk` to a yyyy-mm-dd day (negative = past). Pure string maths
 *  on UK calendar days, so BST never shifts a bucket overnight. */
export function daysBetweenUk(todayUk: string, dayUk: string): number {
  return Math.round((Date.parse(`${dayUk}T00:00:00Z`) - Date.parse(`${todayUk}T00:00:00Z`)) / 86_400_000);
}

/** How close to the move the balance conversation starts (matches the existing
 *  "invoice before move day" nudge). */
export const BALANCE_WINDOW_DAYS = 3;

/** Dashboard needs-action money tiles, counted off the classified /bookings
 *  ledger so tile and queue can never disagree (QA-20260820-02: the tile
 *  counted leads.status='provisional', which diverges the moment a lead is
 *  hand-confirmed with the deposit unpaid). balanceDue is money owed NOW —
 *  a far-future all_set booking owes nothing yet. */
export function moneyTileCounts(rows: ReadonlyArray<{ bucket: BookingBucket }>): {
  awaitingDeposit: number;
  balanceDue: number;
} {
  let awaitingDeposit = 0;
  let balanceDue = 0;
  for (const r of rows) {
    if (r.bucket === "deposit_outstanding") awaitingDeposit++;
    else if (r.bucket === "balance_due" || r.bucket === "balance_overdue") balanceDue++;
  }
  return { awaitingDeposit, balanceDue };
}

export function classifyBooking(s: QueueSignals, todayUk: string): BookingBucket {
  if (!s.depositPaidAt) return "deposit_outstanding";

  if (!s.hasRemovalAppt) {
    const pencilled = !!(s.provisionalDate || s.approxMonth || (s.approxWindow ?? "").trim());
    return pencilled ? "provisional" : "no_date";
  }

  const commitmentOwed = Number(s.commitmentInvoiceAmount ?? 0) > 0 && !s.commitmentPaidAt;
  if (commitmentOwed) {
    const pastDue = !!s.commitmentDueDate && s.commitmentDueDate < todayUk;
    return s.dateReleasableAt || pastDue ? "commitment_overdue" : "commitment_due";
  }

  if (!s.balancePaidAt) {
    const days = s.apptDayUk ? daysBetweenUk(todayUk, s.apptDayUk) : null;
    if (days !== null && days < 0) return "balance_overdue";
    if (s.balanceInvoiceNumber || (days !== null && days <= BALANCE_WINDOW_DAYS)) return "balance_due";
  }

  return "all_set";
}
