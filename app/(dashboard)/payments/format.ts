import { ukParts } from "@/lib/uk-time";

/** Shared display helpers for the /payments tabs (server-side only). */

export function money(pence: number): string {
  const s = (Math.abs(pence) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${pence < 0 ? "−" : ""}£${s}`;
}

export function poundsMoney(pounds: number): string {
  return money(Math.round(pounds * 100));
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

/** The UK calendar day (YYYY-MM-DD) an instant falls on. */
export function ukDayOf(iso: string): string {
  const p = ukParts(new Date(iso));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function dayHeading(day: string, todayDay: string): string {
  if (day === todayDay) return "Today";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
