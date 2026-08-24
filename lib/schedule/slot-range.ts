/**
 * QA-20260823-06. FullCalendar's time-grid views (Week / Day) render ONLY the
 * hours between `slotMinTime` and `slotMaxTime`. Those were pinned at 07:00 and
 * 20:00, so a booking at 21:30 — which the booking dialog itself can produce,
 * since it rounds the default time up from "now" — was completely absent from
 * the two views the office allocates crew from. No "+N more", no scroll cue,
 * nothing. The row was in the database and visible in Month view; Week and Day
 * just quietly did not draw it.
 *
 * Widening the window to a fixed 00:00-24:00 would trade a silent omission for a
 * permanently sparse grid. Instead the window stays at the comfortable working
 * range and STRETCHES only far enough to include whatever is actually booked, so
 * an out-of-hours job pulls the grid open rather than falling off it.
 *
 * Hours are read in Europe/London rather than via `getHours()`: the calendar is
 * UK-only (the codebase pins that zone throughout), and a fixed zone keeps this
 * deterministic in tests instead of inheriting the runner's TZ.
 */

const UK = "Europe/London";

export const DEFAULT_SLOT_MIN_HOUR = 7;
export const DEFAULT_SLOT_MAX_HOUR = 20;

export interface SlotRangeEvent {
  starts_at: string;
  ends_at: string | null;
  all_day?: boolean | null;
}

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** UK-local calendar day + hour + minute for an ISO instant, or null if unparseable. */
function ukParts(iso: string | null | undefined): { day: string; hour: number; minute: number } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const got: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(d)) if (p.type !== "literal") got[p.type] = p.value;
  const hour = Number(got.hour);
  const minute = Number(got.minute);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { day: `${got.year}-${got.month}-${got.day}`, hour, minute };
}

const pad = (h: number) => `${String(h).padStart(2, "0")}:00:00`;

/**
 * The `slotMinTime` / `slotMaxTime` pair that keeps every supplied event visible.
 * Never narrower than the default working window, never wider than a full day.
 */
export function slotRangeFor(events: readonly SlotRangeEvent[]): {
  slotMinTime: string;
  slotMaxTime: string;
} {
  let minHour = DEFAULT_SLOT_MIN_HOUR;
  let maxHour = DEFAULT_SLOT_MAX_HOUR;

  for (const e of events) {
    // All-day events live in FullCalendar's separate all-day row, which the slot
    // window does not clip — including them would stretch the grid for nothing.
    if (e.all_day) continue;

    const start = ukParts(e.starts_at);
    if (!start) continue;
    if (start.hour < minHour) minHour = start.hour;

    const end = ukParts(e.ends_at);
    let endHour: number;
    if (!end || end.day !== start.day) {
      // No end, or it runs past midnight: show the rest of the starting day.
      endHour = end && end.day !== start.day ? 24 : start.hour + 1;
    } else {
      // A job ending at 20:30 needs the 21:00 line drawn to be fully visible.
      endHour = end.minute > 0 ? end.hour + 1 : end.hour;
      if (endHour <= start.hour) endHour = start.hour + 1;
    }
    if (endHour > maxHour) maxHour = endHour;
  }

  minHour = Math.min(Math.max(minHour, 0), 23);
  maxHour = Math.min(Math.max(maxHour, minHour + 1), 24);

  return { slotMinTime: pad(minHour), slotMaxTime: pad(maxHour) };
}
