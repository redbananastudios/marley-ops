/**
 * UK wall-clock helpers. The whole system runs on UK time (Peter, 2026-07-08),
 * but Vercel functions always execute in UTC and reserve the TZ env var — so
 * every SERVER-SIDE day boundary or "at 9am" computation must go through these.
 * (Client components' event handlers are fine as-is — the team's browsers are
 * in the UK — but anything they RENDER is also server-rendered once in UTC, so
 * render-time date text must pin UK_TZ or it hydration-mismatches near
 * midnight through BST: React #418, QA-20260826-03.)
 *
 * Storage stays UTC (timestamptz / toISOString) — these helpers only decide
 * WHICH instant a UK wall-clock time refers to, DST-correct via Intl.
 */

export const UK_TZ = "Europe/London";

interface UkParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** UK wall-clock components of an instant. */
export function ukParts(at: Date = new Date()): UkParts {
  const p = Object.fromEntries(partsFmt.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24, // Intl can emit "24" at midnight
    minute: Number(p.minute),
  };
}

/**
 * The UK calendar day an instant falls on, as `yyyy-mm-dd`. Use wherever a
 * timestamptz has to answer "which day is this job on": a raw `.slice(0, 10)`
 * takes the UTC day, which disagrees with the UK one either side of midnight
 * through BST. Null for a missing or unparseable input.
 */
export function ukCalendarDate(at: string | Date | null | undefined): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const { year, month, day } = ukParts(d);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Short UK display date for an instant — "26 Aug 2026" — pinned to UK_TZ so the
 * server render (UTC) and the browser (UK) produce the same text. "—" for a
 * missing or unparseable input, matching the list pages' empty-cell convention.
 */
export function ukDateShort(at: string | null | undefined): string {
  if (!at) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: UK_TZ,
  });
}

/** Millisecond offset of Europe/London from UTC at the given instant (0 in winter, 3 600 000 in BST). */
export function ukOffsetMs(at: Date = new Date()): number {
  const p = Object.fromEntries(partsFmt.formatToParts(at).map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return wallAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant when a UK wall-clock time occurs. Month is 1-12; day may overflow
 * (Date.UTC normalises), so `ukInstant(y, m, d + 1, 9)` means "9am UK tomorrow".
 * Two-pass so the offset is evaluated AT the target, not now (DST edges).
 */
export function ukInstant(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const guess = new Date(wall - ukOffsetMs(new Date(wall)));
  return new Date(wall - ukOffsetMs(guess));
}

/** Instant of UK midnight for the UK calendar day containing `at`. */
export function startOfUkDay(at: Date = new Date()): Date {
  const p = ukParts(at);
  return ukInstant(p.year, p.month, p.day);
}

/** Instant of hh:mm UK time, `daysAhead` UK calendar days from today. */
export function ukTimeAt(hour: number, minute = 0, daysAhead = 0): Date {
  const p = ukParts();
  return ukInstant(p.year, p.month, p.day + daysAhead, hour, minute);
}
