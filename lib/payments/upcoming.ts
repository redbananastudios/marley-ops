/**
 * "Upcoming money" — expected income over the next N Mon–Sun weeks, assembled
 * purely from the booking rows so it can be unit-tested. Every dated item
 * comes from a REAL date we hold:
 *
 *   commitment   the 25% invoice's own due date (move − 7, stamped when the
 *                customer confirmed their date)
 *   balance      the booked move day — payment in full is due before it, and
 *                the T-7 cron raises the invoice inside that window
 *   commercial   the client's own agreed terms (`quotes.commercial_due_date`,
 *                stamped when the completion invoice is raised)
 *
 * Deposits outstanding are deliberately absent: they are due NOW (the Due tab
 * owns them), not on a future date. Deposit-paid bookings with no committed
 * date can't be dated at all — they land in the undated "pencilled pipeline"
 * with whatever window was captured.
 *
 * TWO ladders, and the move day belongs to only one of them (PRD §3.10).
 * Residential pays in full by move day. Commercial pays ONE invoice, raised by
 * hand when the job completes, due on the client's own terms — 30 or 60 days
 * AFTER the van has been and gone. Dating commercial money on the move day is
 * therefore not a rounding error but the wrong event entirely: it put the money
 * weeks early in the forecast and printed OVERDUE the morning after the job,
 * against an invoice with a month still to run. A false alarm on a board whose
 * only value is being believed is worse than no board.
 *
 * A commercial row arrives here looking exactly like a residential one that
 * owes everything — `depositOfQuote` returns 0 for commercial and the 25% is 0
 * on that ladder, so `balanceAmount` is the whole agreed price — which is why
 * nothing about the row itself gave the old code a clue. Only the snapshotted
 * `paymentPolicy` distinguishes them, so that is what routes.
 *
 * Lateness is NOT recomputed here: `overdue` reads the bucket `classifyBooking`
 * already assigned. A second definition of "overdue" is how the /bookings
 * queue, this board and the `commercial:invoice-overdue` ops alarm end up
 * disagreeing about the same invoice — see lib/ops/commercial-overdue.ts, "one
 * classifier, three surfaces".
 */

import { windowTierLabel } from "@/lib/bookings/booking-details";
import type { BookingBucket } from "@/lib/bookings/queue";

/** The projection of a booking row the assembly needs (subset of
 *  lib/bookings/load-signals#BookingRow, pre-converted to UK days). */
export interface UpcomingSignal {
  quoteId: string;
  quoteRef: string;
  leadId: string;
  customer: string;
  bucket: BookingBucket;
  legacy: boolean;
  /** The ladder SNAPSHOTTED on the quote at acceptance (gate 8), never
   *  re-derived from the client. Absent/unknown is residential — the same
   *  default direction as load-signals and `resolvePaymentPolicy`, and for the
   *  same reason: guessing commercial would stop dating a real balance on its
   *  move day, and the board that would have shown the money is the one the
   *  guess just emptied. */
  paymentPolicy?: "residential" | "commercial" | null;
  /** Commercial only: YYYY-MM-DD the completion invoice falls due, from the
   *  client's terms. Null until the invoice is raised. */
  commercialDueDate?: string | null;
  commitmentInvoiceAmount: number;
  commitmentPaidAt: string | null;
  /** YYYY-MM-DD */
  commitmentDueDate: string | null;
  balanceAmount: number;
  balancePaidAt: string | null;
  /** YYYY-MM-DD UK day of the booked removal, null when nothing is booked. */
  moveDayUk: string | null;
  approxWindow: string | null;
  approxMonth: string | null;
  provisionalDate: string | null;
}

export interface UpcomingItem {
  /** `commercial` is its own kind rather than a `balance`, even though the
   *  money rides the balance columns. It is what the row's LABEL is drawn
   *  from, and "due in full by move day" against a commercial invoice would be
   *  the same wrong-event mistake as dating it there — stated to the office in
   *  words this time. */
  kind: "commitment" | "balance" | "commercial";
  quoteId: string;
  quoteRef: string;
  leadId: string;
  customer: string;
  amount: number;
  /** The day the money is expected by (commitment due date / move day). */
  dueDay: string;
  /** Already past its day but still inside the current week. */
  overdue: boolean;
  legacy: boolean;
}

export interface UpcomingWeek {
  startDay: string;
  endDay: string;
  items: UpcomingItem[];
  total: number;
}

export interface PencilledItem {
  quoteId: string;
  quoteRef: string;
  leadId: string;
  customer: string;
  /** Remaining value still to collect on the booking. */
  amount: number;
  /** "Beginning of September" / "pencilled 2026-09-05" style hint, if any. */
  windowLabel: string | null;
  legacy: boolean;
}

/** Commercial money that exists but cannot be put in a week, because the only
 *  date that would place it — the client's terms — is not on the row.
 *
 *  It gets a list rather than being dropped. Dropping is this board's way of
 *  saying "nothing to report" about a check it could not make, and the row it
 *  would drop is a live unpaid commercial invoice. The `reason` is per-item
 *  because there are two of them and they are NOT the same news: awaiting
 *  completion is the ordinary state of a booked job, while a raised invoice
 *  with no terms date is a defect nothing else will ever call late. One shared
 *  label would file the defect under the ordinary case. */
export interface UndatedCommercialItem {
  quoteId: string;
  quoteRef: string;
  leadId: string;
  customer: string;
  /** The completion invoice's value — the whole agreed price on this ladder. */
  amount: number;
  /** Why it has no date, in the office's own words. */
  reason: string;
  /** True for the terms-date gap, false for the ordinary awaiting-completion
   *  state, so the UI can mark one for attention without re-deriving why. */
  needsAttention: boolean;
  legacy: boolean;
}

/** Invoiced, but nothing on the row says when it falls due. */
export const COMMERCIAL_NO_TERMS_DATE = "invoiced — no terms date, so nothing can say when it falls due";
/** Booked and not yet done; the invoice is raised by hand at completion. */
export const COMMERCIAL_AWAITING_COMPLETION = "awaiting completion — the invoice is raised when the job is done";

export interface UpcomingView {
  weeks: UpcomingWeek[];
  /** Booked money falling beyond the horizon — summarised, not itemised. */
  beyond: { count: number; total: number };
  pencilled: { items: PencilledItem[]; total: number };
  /** Commercial money with no terms date to place it on — see above. */
  commercialUndated: { items: UndatedCommercialItem[]; total: number };
  horizonStart: string;
  horizonEnd: string;
}

const DAY_MS = 86_400_000;

const dayToUtc = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const utcToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Monday of the week containing `day` (Mon–Sun weeks — Peter, 2026-08-16). */
export function mondayOf(day: string): string {
  const ms = dayToUtc(day);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  return utcToDay(ms - dow * DAY_MS);
}

export function buildUpcoming(rows: UpcomingSignal[], todayUk: string, weekCount = 4): UpcomingView {
  const horizonStartMs = dayToUtc(mondayOf(todayUk));
  const horizonEndMs = horizonStartMs + (weekCount * 7 - 1) * DAY_MS;

  const weeks: UpcomingWeek[] = Array.from({ length: weekCount }, (_, i) => ({
    startDay: utcToDay(horizonStartMs + i * 7 * DAY_MS),
    endDay: utcToDay(horizonStartMs + (i * 7 + 6) * DAY_MS),
    items: [],
    total: 0,
  }));
  const beyond = { count: 0, total: 0 };
  const pencilled: PencilledItem[] = [];
  const commercialUndated: UndatedCommercialItem[] = [];

  const place = (item: UpcomingItem): void => {
    const ms = dayToUtc(item.dueDay);
    if (ms < horizonStartMs) return; // older than this week — the Due tab owns it
    if (ms > horizonEndMs) {
      beyond.count++;
      beyond.total += item.amount;
      return;
    }
    const week = weeks[Math.floor((ms - horizonStartMs) / (7 * DAY_MS))];
    week.items.push(item);
    week.total += item.amount;
  };

  for (const r of rows) {
    const base = {
      quoteId: r.quoteId,
      quoteRef: r.quoteRef,
      leadId: r.leadId,
      customer: r.customer,
      legacy: r.legacy,
    };

    // COMMERCIAL runs a different ladder entirely and is answered FIRST, the
    // same way `classifyBooking` answers it first: everything below assumes the
    // residential schedule, and a commercial row falling through picks up the
    // move day as its due date — the defect this branch exists to stop.
    if (r.paymentPolicy === "commercial") {
      const amount = r.balanceAmount;
      if (!r.balancePaidAt && amount > 0) {
        if (r.commercialDueDate) {
          place({
            ...base,
            kind: "commercial",
            amount,
            dueDay: r.commercialDueDate,
            // The classifier's verdict, not a second opinion. `classifyCommercial`
            // draws the boundary at `commercialDueDate < todayUk`, so an invoice
            // due TODAY is in terms until midnight; re-implementing that
            // comparison here is how the board and the ops alarm start
            // disagreeing about the same invoice a day apart.
            overdue: r.bucket === "commercial_overdue",
          });
        } else {
          // No terms date, so no week and no verdict. `!!date && date < today`
          // would read the gap as "in terms" — the reassuring answer produced
          // by having no information at all, which is the shape this codebase
          // has been bitten by repeatedly. The money still shows; only the
          // lateness claim is withheld, and the reason names which of the two
          // silences this is.
          const termsMissing = r.bucket === "commercial_terms_unknown";
          commercialUndated.push({
            ...base,
            amount,
            reason: termsMissing ? COMMERCIAL_NO_TERMS_DATE : COMMERCIAL_AWAITING_COMPLETION,
            needsAttention: termsMissing,
          });
        }
      }
      continue;
    }

    // Raised, unpaid 25% — a real due-date series.
    if (!r.commitmentPaidAt && r.commitmentInvoiceAmount > 0 && r.commitmentDueDate) {
      place({
        ...base,
        kind: "commitment",
        amount: r.commitmentInvoiceAmount,
        dueDay: r.commitmentDueDate,
        overdue: r.commitmentDueDate < todayUk,
      });
    }

    // Booked move with the balance still to come — due in full by move day.
    if (r.moveDayUk && !r.balancePaidAt && r.balanceAmount > 0) {
      place({
        ...base,
        kind: "balance",
        amount: r.balanceAmount,
        dueDay: r.moveDayUk,
        overdue: r.moveDayUk < todayUk,
      });
    }

    // Deposit paid, nothing booked — real future money with no date to put it
    // on. Remaining = unpaid balance + any raised-but-unpaid commitment.
    if (r.bucket === "no_date" || r.bucket === "provisional") {
      const amount =
        (r.balancePaidAt ? 0 : r.balanceAmount) +
        (r.commitmentPaidAt ? 0 : r.commitmentInvoiceAmount);
      if (amount > 0) {
        pencilled.push({
          ...base,
          amount,
          windowLabel: r.provisionalDate
            ? `pencilled ${r.provisionalDate}`
            : (windowTierLabel(r.approxWindow, r.approxMonth) ?? null),
        });
      }
    }
  }

  for (const w of weeks) w.items.sort((a, b) => a.dueDay.localeCompare(b.dueDay));
  pencilled.sort((a, b) => b.amount - a.amount);
  // The terms-date gap sorts to the top: it is the half of this list somebody
  // has to act on, and it is also the half that is invisible everywhere an
  // "overdue" rule does the looking.
  commercialUndated.sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || b.amount - a.amount);

  return {
    weeks,
    beyond,
    pencilled: { items: pencilled, total: pencilled.reduce((s, p) => s + p.amount, 0) },
    commercialUndated: {
      items: commercialUndated,
      total: commercialUndated.reduce((s, c) => s + c.amount, 0),
    },
    horizonStart: utcToDay(horizonStartMs),
    horizonEnd: utcToDay(horizonEndMs),
  };
}
