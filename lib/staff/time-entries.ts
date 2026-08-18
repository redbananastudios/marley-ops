/**
 * Crew daily time entries (pure maths). Crew log a start and finish per day —
 * after the fact, any time up to invoicing, never a punch clock (Peter,
 * 2026-08-18: "we cant say that they are doing 8 hours daily as its variable").
 * Hours are the straight difference, lunch included — the crew enter what they
 * want paying for. Each day can also carry ONE repayable expense (fuel etc.),
 * paid back at cost on the same weekly invoice.
 *
 * Kept separate from staff_availability on purpose: availability is a forward
 * plan ("can we take this job"), time entries are a backward record ("what did
 * this day cost"). Merging them would make each answer the other's question.
 */

import { round2, DEFAULT_DAY_HOURS, type NewStatementLine, type SeedDay } from "@/lib/staff/statements";

/** "HH:MM" or Postgres time "HH:MM:SS" → minutes since midnight, else null. */
export function parseTimeOfDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since midnight → "HH:MM" for display. */
export function formatTimeOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Worked hours for a day: finish − start, to 2dp. Null unless both times parse
 * AND finish is after start — a finish at or before the start is a typo, not an
 * overnight shift (a job running past midnight is logged as two days, one entry
 * each, which keeps every entry inside the pay week it belongs to).
 */
export function entryHours(startedAt: string | null, endedAt: string | null): number | null {
  const start = parseTimeOfDay(startedAt);
  const end = parseTimeOfDay(endedAt);
  if (start == null || end == null || end <= start) return null;
  return round2((end - start) / 60);
}

/** Compact "08:00–18:30" label for descriptions and read-back displays. */
export function timesLabel(startedAt: string | null, endedAt: string | null): string | null {
  const start = parseTimeOfDay(startedAt);
  const end = parseTimeOfDay(endedAt);
  if (start == null || end == null) return null;
  return `${formatTimeOfDay(start)}–${formatTimeOfDay(end)}`;
}

/** One day's logged record, as read from staff_time_entries. */
export interface DayTimeEntry {
  work_date: string; // yyyy-mm-dd
  started_at: string | null; // "HH:MM" / "HH:MM:SS"
  ended_at: string | null;
  expense_amount: number | null;
  expense_note: string | null;
  /** A receipt photo is held in storage for this day's expense. */
  has_receipt?: boolean;
}

/** A day's hours for invoicing: logged hours when the entry has valid times. */
export function loggedHoursByDate(entries: DayTimeEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    const hours = entryHours(e.started_at, e.ended_at);
    if (hours != null) out.set(e.work_date.slice(0, 10), hours);
  }
  return out;
}

const dayName = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/**
 * Suggest draft invoice lines from what actually happened: assigned days give
 * the job label, logged entries give the REAL hours (and the logged times ride
 * in the description so the office approves against evidence, not a bare
 * number). A logged day with no assignment still earns a line (a yard day is
 * real work); an assigned day with nothing logged falls back to the standard
 * `dayHours` suggestion exactly as before, still editable. Expense repayments
 * come last, one line per day, at cost — no rate maths, so they can never
 * inflate the hours total.
 */
export function seedLinesFromWork(
  days: SeedDay[],
  entries: DayTimeEntry[],
  hourlyRate: number | null,
  dayHours: number = DEFAULT_DAY_HOURS,
): NewStatementLine[] {
  const rate = hourlyRate == null ? null : Math.max(0, hourlyRate);
  const fallback = Math.max(0, dayHours);

  const labelByDate = new Map<string, string>();
  for (const d of [...days].sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)))) {
    const key = d.date.slice(0, 10);
    if (!labelByDate.has(key) && d.label) labelByDate.set(key, d.label);
    else if (!labelByDate.has(key)) labelByDate.set(key, "");
  }
  const entryByDate = new Map<string, DayTimeEntry>();
  for (const e of entries) entryByDate.set(e.work_date.slice(0, 10), e);

  // A day earns a worked line when it was assigned OR has logged times. An
  // entry holding only an expense adds no hours line — the receipt day may be
  // a day off (fuel bought the evening before a move).
  const workedDates = new Set<string>(labelByDate.keys());
  for (const [date, e] of entryByDate) {
    if (entryHours(e.started_at, e.ended_at) != null) workedDates.add(date);
  }

  const out: NewStatementLine[] = [];
  for (const date of [...workedDates].sort()) {
    const entry = entryByDate.get(date);
    const logged = entry ? entryHours(entry.started_at, entry.ended_at) : null;
    const hours = logged ?? fallback;
    const times = entry && logged != null ? timesLabel(entry.started_at, entry.ended_at) : null;
    const label = labelByDate.get(date);
    out.push({
      description:
        `Worked ${dayName(date)}` + (times ? ` (${times})` : "") + (label ? ` — ${label}` : ""),
      work_date: date,
      quantity: hours,
      unit_amount: rate,
      amount: round2(rate == null ? 0 : hours * rate),
      source: "job",
    });
  }

  for (const [date, e] of [...entryByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const amount = e.expense_amount == null ? 0 : Number(e.expense_amount);
    if (!(amount > 0)) continue;
    out.push({
      description:
        `Expenses ${dayName(date)}` +
        (e.expense_note?.trim() ? ` — ${e.expense_note.trim()}` : "") +
        // The receipt is the evidence behind the repayment. Flagging its absence
        // IN the description puts it in front of the office and on the PDF —
        // every surface that renders the line — with zero extra plumbing.
        (e.has_receipt ? "" : " (no receipt)"),
      work_date: date,
      quantity: null,
      unit_amount: null,
      amount: round2(amount),
      source: "expense",
    });
  }

  return out;
}
