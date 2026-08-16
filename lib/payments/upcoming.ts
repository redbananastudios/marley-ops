/**
 * "Upcoming money" — expected income over the next N Mon–Sun weeks, assembled
 * purely from the booking rows so it can be unit-tested. Every dated item
 * comes from a REAL date we hold:
 *
 *   commitment   the 25% invoice's own due date (move − 7, stamped when the
 *                customer confirmed their date)
 *   balance      the booked move day — payment in full is due before it, and
 *                the T-7 cron raises the invoice inside that window
 *
 * Deposits outstanding are deliberately absent: they are due NOW (the Due tab
 * owns them), not on a future date. Deposit-paid bookings with no committed
 * date can't be dated at all — they land in the undated "pencilled pipeline"
 * with whatever window was captured.
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
  kind: "commitment" | "balance";
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

export interface UpcomingView {
  weeks: UpcomingWeek[];
  /** Booked money falling beyond the horizon — summarised, not itemised. */
  beyond: { count: number; total: number };
  pencilled: { items: PencilledItem[]; total: number };
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

  return {
    weeks,
    beyond,
    pencilled: { items: pencilled, total: pencilled.reduce((s, p) => s + p.amount, 0) },
    horizonStart: utcToDay(horizonStartMs),
    horizonEnd: utcToDay(horizonEndMs),
  };
}
