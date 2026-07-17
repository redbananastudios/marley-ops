"use client";

/**
 * Crew availability — phone-first. Crew are counted as working Mon–Fri by
 * default; this screen is where they book a day off or OFFER a weekend they can
 * work. One tap per day: [Available | Off]. When a choice matches the default we
 * clear the row (no clutter); otherwise it's saved as an override. Optimistic —
 * the tap lands instantly and reverts with a toast only if the write fails.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { defaultWorkingDay, isWeekend, type EffectiveStatus } from "@/lib/staff/availability";
import { setMyAvailabilityAction } from "@/app/my-jobs/availability/actions";

export interface InitialAvailability {
  date: string; // YYYY-MM-DD
  status: "available" | "unavailable";
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

interface DayInfo {
  date: string;
  dow: string;
  label: string; // "18 Jul"
  weekend: boolean;
  isToday: boolean;
}
interface WeekGroup {
  key: string;
  label: string;
  days: DayInfo[];
}

function buildWeeks(today: string, weeks: number): WeekGroup[] {
  const total = weeks * 7;
  const byWeek = new Map<string, DayInfo[]>();
  const thisMonday = mondayOf(today);
  for (let i = 0; i < total; i++) {
    const date = addDays(today, i);
    const d = new Date(`${date}T00:00:00Z`);
    const wk = mondayOf(date);
    const info: DayInfo = {
      date,
      dow: d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
      label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
      weekend: isWeekend(date),
      isToday: date === today,
    };
    const list = byWeek.get(wk) ?? [];
    list.push(info);
    byWeek.set(wk, list);
  }
  return [...byWeek.entries()].map(([key, days]) => {
    const m = new Date(`${key}T00:00:00Z`);
    return {
      key,
      label:
        key === thisMonday
          ? "This week"
          : `Week of ${m.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}`,
      days,
    };
  });
}

export function AvailabilityEditor({
  initial,
  today,
  weeks = 8,
}: {
  initial: InitialAvailability[];
  today: string;
  weeks?: number;
}) {
  const [overrides, setOverrides] = useState<Map<string, EffectiveStatus>>(
    () => new Map(initial.map((r) => [r.date.slice(0, 10), r.status])),
  );
  const [pending, setPending] = useState<Set<string>>(new Set());
  const weeksData = useMemo(() => buildWeeks(today, weeks), [today, weeks]);

  const effective = (date: string): EffectiveStatus =>
    overrides.get(date) ?? (defaultWorkingDay(date) ? "available" : "unavailable");

  async function setDay(date: string, desired: EffectiveStatus) {
    if (pending.has(date) || effective(date) === desired) return;
    const def: EffectiveStatus = defaultWorkingDay(date) ? "available" : "unavailable";
    const clearing = desired === def;

    const hadPrev = overrides.has(date);
    const prevVal = overrides.get(date);
    setOverrides((m) => {
      const next = new Map(m);
      if (clearing) next.delete(date);
      else next.set(date, desired);
      return next;
    });
    setPending((s) => new Set(s).add(date));
    const r = await setMyAvailabilityAction({ date, status: clearing ? "clear" : desired });
    setPending((s) => {
      const n = new Set(s);
      n.delete(date);
      return n;
    });
    if (!r.ok) {
      // Revert THIS day only — a whole-map snapshot would clobber a concurrent
      // tap on another day that succeeded while this one was in flight (crew on
      // a flaky phone signal tapping several days quickly).
      setOverrides((m) => {
        const next = new Map(m);
        if (hadPrev) next.set(date, prevVal!);
        else next.delete(date);
        return next;
      });
      toast.error(r.error);
    }
  }

  const offeredWeekends = weeksData
    .flatMap((w) => w.days)
    .filter((d) => d.weekend && effective(d.date) === "available").length;

  return (
    <div>
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-mist-500">
          You&apos;re counted as working <span className="font-semibold text-foreground">Monday to Friday</span>. Tap{" "}
          <span className="font-semibold text-mist-600">Off</span> to book a day off, or tap{" "}
          <span className="font-semibold text-success">Available</span> on a weekend you can work.
        </p>
        {offeredWeekends > 0 ? (
          <p className="mt-2 text-sm font-medium text-success">
            You&apos;ve offered {offeredWeekends} weekend day{offeredWeekends === 1 ? "" : "s"}.
          </p>
        ) : null}
      </div>

      {weeksData.map((wk) => (
        <section key={wk.key} className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-mist-400">{wk.label}</h2>
          <div className="space-y-2">
            {wk.days.map((d) => {
              const eff = effective(d.date);
              const busy = pending.has(d.date);
              return (
                <div
                  key={d.date}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5",
                    d.weekend ? "border-survey-border bg-survey-bg/30" : "border-border bg-card",
                  )}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span className="tabular">
                        {d.dow} {d.label}
                      </span>
                      {d.isToday ? (
                        <span className="rounded-pill bg-mm-red px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                          Today
                        </span>
                      ) : null}
                      {d.weekend ? (
                        <span className="text-[11px] font-medium uppercase tracking-wide text-survey-deep">Weekend</span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-mist-400">
                      {eff === "available"
                        ? d.weekend
                          ? "You can work this weekend day"
                          : "Working"
                        : d.weekend
                          ? "Not working (tap Available to offer it)"
                          : "Day off"}
                    </p>
                  </div>

                  <div
                    className={cn(
                      "inline-flex shrink-0 overflow-hidden rounded-md border border-input bg-card",
                      busy && "opacity-60",
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={eff === "available"}
                      disabled={busy}
                      onClick={() => setDay(d.date, "available")}
                      className={cn(
                        "focus-ring min-h-11 px-3.5 text-sm font-semibold transition-colors",
                        eff === "available" ? "bg-success text-white" : "text-mist-400 hover:bg-muted",
                      )}
                    >
                      Available
                    </button>
                    <button
                      type="button"
                      aria-pressed={eff === "unavailable"}
                      disabled={busy}
                      onClick={() => setDay(d.date, "unavailable")}
                      className={cn(
                        "focus-ring min-h-11 border-l border-input px-3.5 text-sm font-semibold transition-colors",
                        eff === "unavailable" ? "bg-mist-500 text-white" : "text-mist-400 hover:bg-muted",
                      )}
                    >
                      Off
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
