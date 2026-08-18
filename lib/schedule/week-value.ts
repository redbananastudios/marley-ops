/**
 * "What is this week worth?" — the £ value of the removals booked in each
 * Mon–Sun week, for the month calendar's week rail.
 *
 * This is deliberately NOT the same question as /payments → Upcoming, which
 * answers "what cash should land this week" (commitment due dates and balances
 * by move day). This one answers "how much work is on", so it is keyed on the
 * move itself. Two surfaces, two questions — keeping them distinct is what
 * stops them looking like they disagree.
 *
 * Counting rules, all of which exist to stop a week reading higher than it is:
 *   - Only a `removal` carries value. A `pack` is the day-before labour for a
 *     move that is already counted; adding it would bill the same job twice.
 *   - Each LEAD counts ONCE, on its earliest removal. A job re-added to the
 *     diary, or split across two appointment rows, must not double the week.
 *   - A multi-day move belongs to the week it STARTS in, so a Sunday→Monday
 *     move lands in one week rather than being counted in both.
 *   - A removal we cannot price (no lead, or a legacy import with no agreed
 *     figure) still counts as a JOB but adds nothing to the money, and is
 *     reported in `unpricedJobs` — a rail that quietly under-reports is worse
 *     than one that says "3 jobs, 2 priced".
 */

import { mondayOf } from "@/lib/payments/upcoming";

export interface WeekValueJob {
  /** Appointment id. */
  id: string;
  leadId: string | null;
  /** 'removal' | 'pack' — only removals are valued. */
  apptType: string;
  /** UK day (yyyy-mm-dd) the appointment STARTS. */
  startDay: string;
  /** Agreed price of the lead's current accepted quote; null when unpriceable. */
  value: number | null;
  /** Still outstanding on that quote (agreed − what has been paid). */
  toCollect: number | null;
  /** Customer name, so the rail can SHOW which jobs make up its count. */
  customer?: string | null;
}

export interface WeekValue {
  /** Monday, yyyy-mm-dd. */
  startDay: string;
  /** Sunday, yyyy-mm-dd. */
  endDay: string;
  /** Removals in the week (deduped by lead). */
  jobCount: number;
  /** Of those, how many carry no price — the money below excludes them. */
  unpricedJobs: number;
  agreedTotal: number;
  toCollect: number;
  /**
   * The customers behind `jobCount`, in date order. The count cannot be
   * verified by eye against the grid — a two-day move draws a chip on both its
   * days, and a busy day collapses to "+N more" — so the rail has to be able
   * to SHOW its working, or it is just a number to be argued with.
   */
  customers: string[];
}

/** The quote fields the value rules need. */
export interface ValuableQuote {
  lead_id: string | null;
  accepted_at: string | null;
  booking_cancelled_at: string | null;
  agreed_price: number | null;
  grand_total: number | null;
  deposit_amount: number | null;
  deposit_paid_at: string | null;
  commitment_invoice_amount: number | null;
  commitment_paid_at: string | null;
}

/**
 * The lead's CURRENT live quote — most recently accepted, cancelled bookings
 * excluded. A re-quoted lead holds two accepted rows, and rows arrive in UUID
 * order, so without this the value would come from whichever won a coin toss.
 * Same rule /bookings uses.
 */
export function pickCurrentQuotes<T extends ValuableQuote>(quotes: T[]): Map<string, T> {
  const current = new Map<string, T>();
  for (const q of quotes) {
    if (!q.lead_id || q.booking_cancelled_at) continue;
    const held = current.get(q.lead_id);
    if (!held || (q.accepted_at ?? "").localeCompare(held.accepted_at ?? "") > 0) current.set(q.lead_id, q);
  }
  return current;
}

/**
 * What one booked job is worth, and what is still owed on it.
 * `agreed_price` is the figure the customer signed up to; `grand_total` is the
 * fallback for a quote accepted before a price was separately agreed. Neither
 * present → UNPRICED (null), never £0: a legacy import with no figure is real
 * work whose value we don't know, and silently calling it nothing would make
 * the week read low.
 */
export function jobValueOf(
  quote: ValuableQuote,
  /** leads.balance_paid_at is set — the job is paid in full whatever the parts. */
  balanceSettled: boolean,
): { value: number | null; toCollect: number | null } {
  const agreed = Number(quote.agreed_price ?? quote.grand_total ?? 0);
  if (!(agreed > 0)) return { value: null, toCollect: null };
  const paid =
    (quote.deposit_paid_at ? Number(quote.deposit_amount ?? 0) : 0) +
    (quote.commitment_paid_at ? Number(quote.commitment_invoice_amount ?? 0) : 0);
  return { value: agreed, toCollect: balanceSettled ? 0 : Math.max(0, agreed - paid) };
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Bucket jobs into the given Mon–Sun weeks. `weekStarts` are Mondays (the
 * calendar's own rows), so a month grid gets exactly the six weeks it draws —
 * including the leading/trailing days that belong to the neighbouring months,
 * which is correct: the rail describes the ROW, not the month.
 */
export function buildWeekValues(jobs: WeekValueJob[], weekStarts: string[]): Map<string, WeekValue> {
  const out = new Map<string, WeekValue>();
  for (const startDay of weekStarts) {
    out.set(startDay, {
      startDay,
      endDay: addDays(startDay, 6),
      jobCount: 0,
      unpricedJobs: 0,
      agreedTotal: 0,
      toCollect: 0,
      customers: [],
    });
  }

  // One entry per lead, earliest removal wins. Lead-less removals (manual diary
  // blocks) can't be deduped by lead, so they key on their own id — they are
  // never priced anyway.
  const perLead = new Map<string, WeekValueJob>();
  for (const job of jobs) {
    if (job.apptType !== "removal") continue;
    const key = job.leadId ?? `appt:${job.id}`;
    const held = perLead.get(key);
    if (!held || job.startDay < held.startDay) perLead.set(key, job);
  }

  for (const job of [...perLead.values()].sort((a, b) => a.startDay.localeCompare(b.startDay))) {
    const week = out.get(mondayOf(job.startDay));
    if (!week) continue; // outside the drawn rows
    week.jobCount += 1;
    week.customers.push(job.customer?.trim() || "Unnamed job");
    if (job.value == null) {
      week.unpricedJobs += 1;
      continue;
    }
    week.agreedTotal += job.value;
    week.toCollect += job.toCollect ?? 0;
  }

  return out;
}
