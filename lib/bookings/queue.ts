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

/** How close to the move the balance falls due. 7 days, matching the T-7
 *  automatic final balance invoice — the point at which the customer is
 *  actually asked for the money (Peter, 2026-08-20). */
export const BALANCE_WINDOW_DAYS = 7;

/** What a booking owes RIGHT NOW, in money the business can actually ask for
 *  today. Deliberately independent of `classifyBooking`: that ladder puts a
 *  booking in exactly ONE bucket, so an unpaid deposit used to mask the
 *  balance on a job moving the same week (QA-20260820-04 — three move-day jobs
 *  owing £5,400 read as £600). A booking can owe the 25% AND the balance at
 *  once, so the money is computed per obligation, not per bucket.
 *
 *  The £100 deposit is NEVER counted (Peter, 2026-08-20): it secures the
 *  booking rather than falling due on a date, so counting it inflates "owed
 *  right now" with money nobody is chasing today. It keeps its own queue on
 *  /payments — it just isn't part of the headline.
 *
 *  No double-count by construction: `balanceAmount` is already
 *  agreed − deposit − commitment (see load-signals), so commitment + balance
 *  is exactly what is outstanding after the deposit. */
export interface OwedSignals {
  commitmentInvoiceAmount: number;
  commitmentPaidAt: string | null;
  commitmentDueDate: string | null;
  dateReleasableAt: string | null;
  balanceAmount: number;
  balancePaidAt: string | null;
  balanceInvoiceNumber: string | null;
  hasRemovalAppt: boolean;
  apptDayUk: string | null;
}

export interface OwedNow {
  /** Invoiced-and-unpaid 25%. */
  commitment: number;
  /** Balance that has fallen due (invoiced, inside the window, or move passed). */
  balance: number;
  total: number;
  /** The portion of `total` already past its date — chase first. */
  overdue: number;
}

export function owedNow(s: OwedSignals, todayUk: string): OwedNow {
  const commitmentAmount = Number(s.commitmentInvoiceAmount ?? 0);
  const commitmentOwed = commitmentAmount > 0 && !s.commitmentPaidAt ? commitmentAmount : 0;
  const commitmentPastDue =
    commitmentOwed > 0 && (!!s.dateReleasableAt || (!!s.commitmentDueDate && s.commitmentDueDate < todayUk));

  const days = s.apptDayUk ? daysBetweenUk(todayUk, s.apptDayUk) : null;
  const balanceAmount = Number(s.balanceAmount ?? 0);
  // A balance is only askable once there is a real move behind it: a booking
  // with no date owes nothing *today*, however large the job.
  const balanceIsDue =
    !s.balancePaidAt &&
    balanceAmount > 0 &&
    s.hasRemovalAppt &&
    (!!s.balanceInvoiceNumber || (days !== null && days <= BALANCE_WINDOW_DAYS));
  const balanceOwed = balanceIsDue ? balanceAmount : 0;
  const balancePastDue = balanceOwed > 0 && days !== null && days < 0;

  return {
    commitment: commitmentOwed,
    balance: balanceOwed,
    total: commitmentOwed + balanceOwed,
    overdue: (commitmentPastDue ? commitmentOwed : 0) + (balancePastDue ? balanceOwed : 0),
  };
}

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
