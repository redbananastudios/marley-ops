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
  /** Commercial: the job is booked and not yet done, so nothing is owed and
   *  nothing is chased. It sits here purely so the office can see it. */
  | "commercial_awaiting_completion"
  /** Commercial: completed, invoiced, inside the client's terms. */
  | "commercial_invoiced"
  /** Commercial: past the client's terms. Raises an INTERNAL alert only —
   *  a commercial customer is never chased by email (PRD §3.10). */
  | "commercial_overdue"
  /** Commercial: invoiced, but the row carries NO terms date, so whether it is
   *  late is unknown rather than answered. Its own bucket precisely because
   *  "in terms" and "we cannot tell" are different answers and must not share
   *  a rendering. */
  | "commercial_terms_unknown"
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
  /** What the balance invoice will (or does) ask for — the same figure
   *  load-signals hands `owedNow`. OPTIONAL, and absence means UNKNOWN, which
   *  keeps the pre-gate-9a behaviour: only a KNOWN £0 with no issued invoice
   *  may read as "no balance exists" (a fully-collected small job). Reading
   *  absence as zero would silently empty a chase list, which is the failure
   *  direction this codebase never chooses. */
  balanceAmount?: number | null;
  /** The policy SNAPSHOTTED on the quote at acceptance (gate 8), never
   *  re-derived from the client - editing a client's type must not rewrite
   *  the schedule of a booking already in flight. Absent/unknown is
   *  residential, which is what every booking before gate 8 ran. */
  paymentPolicy?: "residential" | "commercial" | null;
  /** Commercial only: the removal appointment is marked completed, which is
   *  what makes the invoice raisable. */
  jobCompleted?: boolean;
  /** Commercial only: yyyy-mm-dd the completion invoice falls due, from the
   *  client's own terms. Null until the invoice is raised. */
  commercialDueDate?: string | null;
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
  /** See QueueSignals.paymentPolicy - snapshotted, never re-derived. */
  paymentPolicy?: "residential" | "commercial" | null;
  /** Commercial only: when the completion invoice falls due. */
  commercialDueDate?: string | null;
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
  /** The 25% half of `overdue`, and the balance half. Split because the two
   *  are chased in DIFFERENT sections: a combined figure can be shown in a
   *  headline but cannot say which list holds it, and a headline whose money
   *  is in no list is the defect this seam exists to stop. Each is all-or-
   *  nothing — an obligation is past its date or it is not — so
   *  `commitmentOverdue` is either 0 or `commitment`, and likewise for the
   *  balance. `overdue` stays their sum. */
  commitmentOverdue: number;
  balanceOverdue: number;
}

/**
 * The commercial ladder: no deposit, no commitment, no customer chase. One
 * invoice, raised when the job is done, due on the client's own terms.
 *
 * The balance columns carry it - `-BAL` is the last invoice on a job either
 * way, so reusing them needs no new suffix and no new match_kind (PRD §10).
 * What differs is only WHEN it is raised (completion, not T-7) and when it
 * falls due (the client's terms, not before move day).
 *
 * This comment used to claim the reuse ALSO kept "/finance, the bank-feed
 * matcher and the ledger adapter working". It did not, and saying so is part of
 * why nobody checked: `loadLedgerItems` gated its balance item on
 * `deposit_paid_at`, which commercial never has, so the completion invoice was
 * invisible to the matcher, to `reconcileSettled` and to the office's manual
 * attach flow. Fixed 2026-09-01 via `balanceRungVisible` in lib/bank-feed/sync.
 * Reusing a column shape does not by itself make a reader policy-aware - each
 * reader still has to be checked, and the check is a test, not a sentence.
 */
function classifyCommercial(s: QueueSignals, todayUk: string): BookingBucket {
  if (s.balancePaidAt) return "all_set";
  // Not invoiced yet. Before completion that is simply where the job lives;
  // AFTER completion it means the completion invoice has not been raised, and
  // the office needs to see that just as plainly - so both states share the
  // awaiting bucket rather than one of them vanishing into all_set.
  if (!s.balanceInvoiceNumber) return "commercial_awaiting_completion";
  // An invoice with no terms date cannot be called either. `!!date && date <
  // today` reads a missing date as false, which renders as "in terms" - the
  // reassuring answer, produced by having no information at all. That is the
  // shape this codebase has been bitten by four times: the surface that would
  // have shown the gap is the one the guess just cleared. So it gets its own
  // bucket and its own section, where the office can see that the terms are
  // missing rather than be told the invoice is fine.
  if (!s.commercialDueDate) return "commercial_terms_unknown";
  return s.commercialDueDate < todayUk ? "commercial_overdue" : "commercial_invoiced";
}

export function owedNow(s: OwedSignals, todayUk: string): OwedNow {
  // Commercial owes NOTHING until its completion invoice exists - there is no
  // deposit and no 25%, and inventing an obligation from the agreed price
  // would put money on the /payments headline that nobody has been asked for.
  // Once raised it owes the whole invoice, and goes overdue on the client's
  // terms rather than on the move date.
  if (s.paymentPolicy === "commercial") {
    const amount = Number(s.balanceAmount ?? 0);
    const owed = !s.balancePaidAt && amount > 0 && !!s.balanceInvoiceNumber ? amount : 0;
    // Deliberately NOT the same treatment `classifyBooking` gives a missing
    // terms date. `overdue` is a claim of fact about a date, and with no date
    // there is no fact to state — so it stays out of the overdue figure while
    // the full invoice still counts in `total`. The money is never hidden; only
    // the lateness assertion is withheld, and the row's own bucket
    // (commercial_terms_unknown) is what puts the gap in front of the office.
    const pastTerms = owed > 0 && !!s.commercialDueDate && s.commercialDueDate < todayUk;
    return {
      commitment: 0,
      balance: owed,
      total: owed,
      overdue: pastTerms ? owed : 0,
      commitmentOverdue: 0,
      balanceOverdue: pastTerms ? owed : 0,
    };
  }

  const commitmentAmount = Number(s.commitmentInvoiceAmount ?? 0);
  const commitmentOwed = commitmentAmount > 0 && !s.commitmentPaidAt ? commitmentAmount : 0;
  const commitmentPastDue =
    commitmentOwed > 0 && (!!s.dateReleasableAt || (!!s.commitmentDueDate && s.commitmentDueDate < todayUk));

  const days = s.apptDayUk ? daysBetweenUk(todayUk, s.apptDayUk) : null;
  const balanceAmount = Number(s.balanceAmount ?? 0);
  // An INVOICED balance is owed on its own authority: the customer has been
  // sent a document asking for it, so a diary entry is not what makes it real.
  // Requiring a removal appointment for that case hid gate 9b's late-booking
  // balance and gate 9c's settle-in-full balance from BOTH money headlines —
  // each is raised at acceptance, days before the office allocates the slot,
  // and 9b only fires for moves already inside T-7. So the jobs moving soonest
  // were the ones reporting £0 owed.
  //
  // The window-implied case still needs the appointment, which is what the
  // guard was written for: inferring a balance from a date nobody has
  // committed to would have a booking with no date owe money today, however
  // large the job. Issued and inferred are different claims.
  const balanceIsDue =
    !s.balancePaidAt &&
    balanceAmount > 0 &&
    (!!s.balanceInvoiceNumber || (s.hasRemovalAppt && days !== null && days <= BALANCE_WINDOW_DAYS));
  const balanceOwed = balanceIsDue ? balanceAmount : 0;
  const balancePastDue = balanceOwed > 0 && days !== null && days < 0;

  return {
    commitment: commitmentOwed,
    balance: balanceOwed,
    total: commitmentOwed + balanceOwed,
    overdue: (commitmentPastDue ? commitmentOwed : 0) + (balancePastDue ? balanceOwed : 0),
    commitmentOverdue: commitmentPastDue ? commitmentOwed : 0,
    balanceOverdue: balancePastDue ? balanceOwed : 0,
  };
}

/** Dashboard needs-action money tiles, counted off the classified /bookings
 *  ledger so tile and queue can never disagree (QA-20260820-02: the tile
 *  counted leads.status='provisional', which diverges the moment a lead is
 *  hand-confirmed with the deposit unpaid). balanceDue is money owed NOW —
 *  a far-future all_set booking owes nothing yet.
 *
 *  It counts OBLIGATIONS, via `queueMoney`, rather than the two balance
 *  BUCKETS it used to test. The bucket ladder only reaches `balance_*` once
 *  the deposit is paid and a removal appointment exists, so a gate 9b late
 *  booking — balance invoice raised at acceptance, deposit unpaid, slot not
 *  yet allocated — bucketed as `deposit_outstanding` and the card read "No
 *  balances outstanding" against a live unpaid invoice. Commercial rows were
 *  counted by neither branch: their completion invoice is never a `balance_*`
 *  bucket at all. Delegating means the card, the /bookings tile and the
 *  /payments headline can only ever be three renderings of one sum. */
export function moneyTileCounts(
  rows: ReadonlyArray<{ bucket: BookingBucket; deposit: number; owed: OwedNow }>,
): {
  awaitingDeposit: number;
  balanceDue: number;
} {
  const m = queueMoney(rows);
  return { awaitingDeposit: m.depositJobs, balanceDue: m.balanceJobs };
}

/** Every money headline on /bookings and /payments Due, from ONE ledger and
 *  computed per OBLIGATION, never per bucket.
 *
 *  `classifyBooking` puts a row in exactly one rung, and it only reaches
 *  `commitment_*` once the deposit is paid AND a removal appointment exists.
 *  `ensureCommitmentInvoice` requires neither: a confirmed date and the
 *  customer's date_confirm signature are enough. So a bucket-based sum
 *  silently drops every invoiced-and-unpaid 25% sitting in
 *  `deposit_outstanding`, `no_date` or `provisional` — money the office is
 *  actively chasing, absent from the tile that names it. That is the same
 *  shape that once hid balances behind an unpaid deposit (QA-20260820-04);
 *  the balance tile was fixed then and the 25% tile was left behind
 *  (QA-20260826-01).
 *
 *  Bucket membership decides which LIST a row appears in, and nothing else.
 *  Deposits stay out of `owedNow` (Peter, 2026-08-20) and are reported
 *  separately, so the two are never added together by accident. */
export interface QueueMoney {
  /** Deposit money still outstanding — its own tile, never part of owedNow. */
  depositsOutstanding: number;
  depositJobs: number;
  commitment: number;
  /** Rows carrying an unpaid 25%, however they are bucketed. */
  commitmentJobs: number;
  balance: number;
  /** Rows carrying an unpaid balance, however they are bucketed — includes a
   *  commercial completion invoice, which reaches no `balance_*` bucket. */
  balanceJobs: number;
  /** commitment + balance — /payments "Owed right now". */
  owedNow: number;
  /** The portion of owedNow already past its date. */
  overdue: number;
  /** `overdue` split the way the SECTIONS below the tile are split, so each
   *  tile can name the lists that add up to it. */
  commitmentOverdue: number;
  balanceOverdue: number;
}

export function queueMoney(
  rows: ReadonlyArray<{ bucket: BookingBucket; deposit: number; owed: OwedNow }>,
): QueueMoney {
  let depositsOutstanding = 0;
  let depositJobs = 0;
  let commitment = 0;
  let commitmentJobs = 0;
  let balance = 0;
  let balanceJobs = 0;
  let commitmentOverdue = 0;
  let balanceOverdue = 0;
  for (const r of rows) {
    if (r.bucket === "deposit_outstanding") {
      depositsOutstanding += r.deposit;
      depositJobs++;
    }
    if (r.owed.commitment > 0) commitmentJobs++;
    if (r.owed.balance > 0) balanceJobs++;
    commitment += r.owed.commitment;
    balance += r.owed.balance;
    commitmentOverdue += r.owed.commitmentOverdue;
    balanceOverdue += r.owed.balanceOverdue;
  }
  return {
    depositsOutstanding,
    depositJobs,
    commitment,
    commitmentJobs,
    balance,
    balanceJobs,
    owedNow: commitment + balance,
    overdue: commitmentOverdue + balanceOverdue,
    commitmentOverdue,
    balanceOverdue,
  };
}

export function classifyBooking(s: QueueSignals, todayUk: string): BookingBucket {
  // Commercial runs a different ladder entirely and must be answered FIRST:
  // every rung below is residential, and a commercial booking has no deposit,
  // so falling through would park it in `deposit_outstanding` forever - on a
  // chase queue for money nobody agreed to pay up front.
  if (s.paymentPolicy === "commercial") return classifyCommercial(s, todayUk);

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

  // Gate 9a: a small job's acceptance ask WAS the gross, so no balance exists,
  // no -BAL invoice will ever raise and balance_paid_at never stamps — without
  // this a fully-collected job sat in balance_due/balance_overdue chasing £0
  // forever. Only a KNOWN zero with no issued invoice reads as settled: an
  // issued invoice keeps its authority whatever its figure, and an absent
  // amount is unknown, which keeps the chase-side behaviour unchanged.
  const noBalanceExists =
    !s.balanceInvoiceNumber && s.balanceAmount != null && Number(s.balanceAmount) <= 0;
  if (!s.balancePaidAt && !noBalanceExists) {
    const days = s.apptDayUk ? daysBetweenUk(todayUk, s.apptDayUk) : null;
    if (days !== null && days < 0) return "balance_overdue";
    if (s.balanceInvoiceNumber || (days !== null && days <= BALANCE_WINDOW_DAYS)) return "balance_due";
  }

  return "all_set";
}
