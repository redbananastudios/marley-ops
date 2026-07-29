/**
 * Crew contractor-invoice / timesheet maths (pure). NO VAT anywhere: crew are
 * self-employed and not VAT-registered, so an invoice is a plain payment record,
 * never a VAT self-bill.
 *
 * Pay is HOURS × the crew member's hourly rate (Connor + Leanne, 2026-07-19).
 * `seedLinesFromDays` SUGGESTS one line per assigned day at the standard day
 * length × their rate; every line stays editable (they log actual hours). A
 * guaranteed crew member (Rob: £600/week whether there's work or not) gets a
 * `guaranteeTopUp` added as a system line so a light week reaches the floor.
 */

/** Standard working day, in hours — seeds a day's hours on the timesheet
 *  (Peter, 2026-07-19: "a day is 8 hours typically"). The crew edit the actual
 *  hours per line. */
export const DEFAULT_DAY_HOURS = 8;

/** Hard per-line ceiling. No single crew/estimator invoice line is legitimately
 *  this large; it caps a fat-finger (e.g. 800 hrs instead of 8) or a direct
 *  PostgREST post at a sane bound instead of the numeric(10,2) ~£100M limit.
 *  Enforced in the line-upsert action (the office still approves before pay). */
export const MAX_LINE_AMOUNT = 10_000;

export type StatementStatus = "draft" | "submitted" | "paid" | "void";

/** Money rounded to whole pennies — avoids 0.1 + 0.2 float drift in totals. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** A line's effective amount: quantity × rate when BOTH are given, otherwise the
 *  directly-entered amount. Never negative; always to the penny. */
export function computeLineAmount(
  quantity: number | null,
  unitAmount: number | null,
  amount: number | null,
): number {
  if (quantity != null && unitAmount != null) return round2(Math.max(0, quantity * unitAmount));
  return round2(Math.max(0, amount ?? 0));
}

/** Statement total = sum of line amounts, to the penny. */
export function statementTotal(lines: { amount: number | null }[]): number {
  return round2(lines.reduce((s, l) => s + (l.amount ?? 0), 0));
}

/** Weekly-guarantee top-up: the amount to add so a guaranteed crew member's week
 *  reaches the floor (Rob: £600 whether there's work or not). Zero when there is
 *  no guarantee, or when the hours already earn at or above it (they keep the
 *  higher figure — the guarantee is a floor, not a cap). */
export function guaranteeTopUp(linesTotal: number, weeklyGuarantee: number | null): number {
  if (weeklyGuarantee == null || weeklyGuarantee <= 0) return 0;
  return round2(Math.max(0, weeklyGuarantee - linesTotal));
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOfIso(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export interface Period {
  start: string;
  end: string;
}

/** The Mon–Sun pay week containing `iso`. */
export function weekPeriodOf(iso: string): Period {
  const start = mondayOfIso(iso);
  return { start, end: addDaysIso(start, 6) };
}

/** The Mon–Sun week before the one containing `iso` (the week just finished). */
export function previousWeekPeriod(iso: string): Period {
  const start = addDaysIso(mondayOfIso(iso), -7);
  return { start, end: addDaysIso(start, 6) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact inclusive period label: "21–27 Jul" / "28 Jul – 3 Aug" / "21 Jul". */
export function periodLabel(start: string, end: string): string {
  const s = new Date(`${start.slice(0, 10)}T12:00:00Z`);
  const e = new Date(`${end.slice(0, 10)}T12:00:00Z`);
  const sMon = MONTHS[s.getUTCMonth()];
  const eMon = MONTHS[e.getUTCMonth()];
  if (start.slice(0, 10) === end.slice(0, 10)) return `${s.getUTCDate()} ${sMon}`;
  if (sMon === eMon && s.getUTCFullYear() === e.getUTCFullYear()) return `${s.getUTCDate()}–${e.getUTCDate()} ${eMon}`;
  return `${s.getUTCDate()} ${sMon} – ${e.getUTCDate()} ${eMon}`;
}

export interface SeedDay {
  date: string;
  label?: string | null; // e.g. "Move — Smith" — a short jobs summary for that day
}

export interface NewStatementLine {
  description: string;
  work_date: string | null;
  quantity: number | null;
  unit_amount: number | null;
  amount: number;
  source: "manual" | "job" | "retainer" | "guarantee";
}

/** Suggest draft lines from the days a crew member was assigned — ONE line per
 *  DAY at `dayHours` × their hourly rate (they then edit the actual hours).
 *  Deduped and date-sorted; extra/retainer lines are added by hand afterwards. */
export function seedLinesFromDays(
  days: SeedDay[],
  hourlyRate: number | null,
  dayHours: number = DEFAULT_DAY_HOURS,
): NewStatementLine[] {
  const seen = new Set<string>();
  const out: NewStatementLine[] = [];
  const rate = hourlyRate == null ? null : Math.max(0, hourlyRate);
  const hours = Math.max(0, dayHours);
  for (const d of [...days].sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)))) {
    const key = d.date.slice(0, 10);
    if (seen.has(key)) continue;
    seen.add(key);
    const wd = new Date(`${key}T12:00:00Z`);
    const dayName = wd.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    out.push({
      description: d.label ? `Worked ${dayName} — ${d.label}` : `Worked ${dayName}`,
      work_date: key,
      quantity: hours,
      unit_amount: rate,
      amount: round2(rate == null ? 0 : hours * rate),
      source: "job",
    });
  }
  return out;
}
