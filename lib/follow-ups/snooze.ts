/**
 * Snooze durations for a follow-up, and the labels shown on the queue.
 *
 * One table, two call sites: the /follow-ups queue and the lead page's open
 * follow-ups strip both offered these options as hardcoded JSX with a private
 * copy of the date helper, so adding an option meant editing the same list
 * twice and the two could silently drift apart.
 *
 * Everything lands at 09:00 — a follow-up is morning work, and the existing
 * `tomorrowMorning()` used by the No-reply action already sets that expectation.
 */

export type SnoozeValue = "1" | "3" | "7" | "14" | "month";

export interface SnoozeOption {
  value: SnoozeValue;
  label: string;
}

export const SNOOZE_OPTIONS: readonly SnoozeOption[] = [
  { value: "1", label: "Tomorrow" },
  { value: "3", label: "In 3 days" },
  { value: "7", label: "In a week" },
  { value: "14", label: "In a fortnight" },
  { value: "month", label: "In a month" },
] as const;

const AT_HOUR = 9;

/** N days from `from`, at 09:00 local. */
export function snoozeByDays(days: number, from: Date = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(AT_HOUR, 0, 0, 0);
  return d;
}

/**
 * One calendar month on, at 09:00 local — 10 Aug → 10 Sept, which is what
 * "in a month" means to a person.
 *
 * Clamped to the last day of the target month: setMonth() on the 31st of a
 * 30-day-later month rolls FORWARD (31 Jan + 1 month = 3 March in JS), so a
 * naive implementation would quietly snooze five weeks instead of four.
 */
export function snoozeByMonth(from: Date = new Date()): Date {
  const day = from.getDate();
  const d = new Date(from);
  d.setDate(1); // pin to a day every month has before shifting
  d.setMonth(d.getMonth() + 1);
  const lastDayOfTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDayOfTarget));
  d.setHours(AT_HOUR, 0, 0, 0);
  return d;
}

/** Resolve a menu choice to the ISO instant the action writes to `due_at`. */
export function snoozeUntil(value: SnoozeValue, from: Date = new Date()): string {
  return (value === "month" ? snoozeByMonth(from) : snoozeByDays(Number(value), from)).toISOString();
}
