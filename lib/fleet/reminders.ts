/**
 * Fleet-expiry reminder engine (pure). Given the fleet, "today", and the
 * send-log, decide which reminders to send now. The daily cron (M3) calls this,
 * then sends email + push per result and writes a log row for every threshold in
 * `record` — so nothing sends twice and a late-entered date fires once, not for
 * every crossed bucket.
 *
 * Cadence: first alert at 28 days out, then 14 / 7 / 3 / 0 (day-of), then WEEKLY
 * while overdue (a week-stamped threshold keeps each week's row unique in the log).
 */

import { docStatus, VEHICLE_EXPIRIES, type VehicleExpiryDates, type VehicleExpiryKey } from "@/lib/vehicles";

/** Days-before buckets, loosest first, tightest last. */
export const REMINDER_THRESHOLDS = [28, 14, 7, 3, 0] as const;

export interface FleetVehicle extends VehicleExpiryDates {
  id: string;
  name: string;
}

export interface ReminderLogRow {
  vehicle_id: string;
  expiry_type: string;
  due_date: string; // YYYY-MM-DD
  threshold: string; // '28' | '14' | '7' | '3' | '0' | 'overdue-YYYY-Www'
}

export interface DueReminder {
  vehicle_id: string;
  vehicle_name: string;
  expiry_type: VehicleExpiryKey;
  expiry_label: string;
  due_date: string; // YYYY-MM-DD
  threshold: string; // the bucket that triggered this alert
  days: number; // whole days until due (negative = overdue by that many)
  /** Every threshold to record as sent this run (includes `threshold`, plus any
   *  looser buckets already crossed but never sent — so a late date fires once). */
  record: string[];
}

/** ISO-8601 week of a UK calendar day, e.g. "2026-W29" (ISO week-year handles the
 *  Dec/Jan boundary). The overdue reminder uses this so it re-fires once per week. */
export function isoWeek(today: Date): string {
  const ukDay = today.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const [y, m, d] = ukDay.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThu.getTime()) / (7 * 86_400_000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The threshold string an overdue expiry uses this week. */
export function overdueThreshold(today: Date): string {
  return `overdue-${isoWeek(today)}`;
}

const logKey = (vehicleId: string, type: string, dueDate: string) =>
  `${vehicleId}|${type}|${dueDate.slice(0, 10)}`;

/** Reminders due to send right now. Empty when nothing has crossed a fresh bucket. */
export function dueReminders(vehicles: FleetVehicle[], today: Date, log: ReminderLogRow[]): DueReminder[] {
  const sentByKey = new Map<string, Set<string>>();
  for (const r of log) {
    const k = logKey(r.vehicle_id, r.expiry_type, r.due_date);
    (sentByKey.get(k) ?? sentByKey.set(k, new Set()).get(k)!).add(r.threshold);
  }

  const out: DueReminder[] = [];
  for (const v of vehicles) {
    for (const e of VEHICLE_EXPIRIES) {
      const raw = v[e.key];
      if (!raw) continue;
      const st = docStatus(raw, today);
      if (st.days === null) continue;
      const days = st.days;
      const dueDate = raw.slice(0, 10);
      const sent = sentByKey.get(logKey(v.id, e.key, dueDate)) ?? new Set<string>();

      if (days >= 0) {
        const reached = REMINDER_THRESHOLDS.filter((t) => days <= t).map(String);
        if (!reached.length) continue; // further out than 28 days
        const unsent = reached.filter((t) => !sent.has(t));
        if (!unsent.length) continue; // every crossed bucket already sent
        out.push({
          vehicle_id: v.id,
          vehicle_name: v.name,
          expiry_type: e.key,
          expiry_label: e.label,
          due_date: dueDate,
          threshold: reached[reached.length - 1], // tightest bucket crossed
          days,
          record: unsent,
        });
      } else {
        const wk = overdueThreshold(today);
        if (sent.has(wk)) continue; // already nudged this week
        out.push({
          vehicle_id: v.id,
          vehicle_name: v.name,
          expiry_type: e.key,
          expiry_label: e.label,
          due_date: dueDate,
          threshold: wk,
          days,
          record: [wk],
        });
      }
    }
  }
  return out;
}
