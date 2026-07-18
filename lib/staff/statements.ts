/**
 * Staff self-billing / payment statements (pure) — the money maths for the crew
 * pay ledger. NO VAT anywhere: crew are self-employed and not VAT-registered, so
 * a statement is a plain payment record, never a VAT self-bill.
 *
 * Pay is NOT derived from jobs or availability (retainers mean crew get paid on
 * days with no work), so the crew build their own lines with a free description.
 * `seedLinesFromDays` only SUGGESTS lines from the days they were assigned — a
 * convenience starting point; every line stays editable.
 */

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
  source: "manual" | "job" | "retainer";
}

/** Suggest draft lines from the days a crew member was assigned — ONE line per
 *  DAY (pay is per day, not per job), amount = their day rate. Deduped and
 *  date-sorted. Retainer / extra days are added by hand afterwards. */
export function seedLinesFromDays(days: SeedDay[], dayRate: number | null): NewStatementLine[] {
  const seen = new Set<string>();
  const out: NewStatementLine[] = [];
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
      quantity: 1,
      unit_amount: dayRate,
      amount: round2(Math.max(0, dayRate ?? 0)),
      source: "job",
    });
  }
  return out;
}
