"use client";

/**
 * Crew availability — phone-first, Timetastic-style. Two moves:
 *   1. "My normal week" — big Mon–Sun chips that set the crew member's weekly
 *      WORKING PATTERN (working_days). Set once; a casual just fills the days
 *      they do. Retained crew show Mon–Fri filled.
 *   2. A calendar of big day cells. A day only needs a tap when it differs from
 *      the pattern: a normal day booked off, or a non-pattern day (weekend / rest
 *      day) offered. Tapping a day opens a bottom sheet with two fat buttons.
 * Optimistic — taps land instantly and revert PER DAY (never a whole-map
 * snapshot, which would clobber a concurrent tap on a flaky signal) on failure.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isoWeekday, isWeekend, patternLabel } from "@/lib/staff/availability";
import { setMyAvailabilityAction, setMyWorkingDaysAction } from "@/app/my-jobs/availability/actions";

export interface InitialAvailability {
  date: string; // YYYY-MM-DD
  status: "available" | "unavailable";
}

type CellState = "working" | "off" | "offered" | "rest";

const CHIPS: { iw: number; l: string }[] = [
  { iw: 1, l: "Mon" },
  { iw: 2, l: "Tue" },
  { iw: 3, l: "Wed" },
  { iw: 4, l: "Thu" },
  { iw: 5, l: "Fri" },
  { iw: 6, l: "Sat" },
  { iw: 7, l: "Sun" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
  iso: string;
  num: number;
  month: number;
  weekend: boolean;
  isToday: boolean;
  isPast: boolean;
}
interface WeekRow {
  key: string;
  monthLabel: string | null; // shown when this week opens a new month
  days: DayInfo[];
}

export function AvailabilityEditor({
  initial,
  today,
  weeks = 8,
  workingDays,
}: {
  initial: InitialAvailability[];
  today: string;
  weeks?: number;
  workingDays: number[];
}) {
  const [pattern, setPattern] = useState<number[]>(() => [...workingDays].sort((a, b) => a - b));
  const [overrides, setOverrides] = useState<Map<string, "available" | "unavailable">>(
    () => new Map(initial.map((r) => [r.date.slice(0, 10), r.status])),
  );
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [patPending, setPatPending] = useState<number | null>(null);
  const [sheetDate, setSheetDate] = useState<string | null>(null);

  const weekRows = useMemo<WeekRow[]>(() => {
    const start = mondayOf(today);
    const rows: WeekRow[] = [];
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const days: DayInfo[] = [];
      for (let i = 0; i < 7; i++) {
        const iso = addDays(start, w * 7 + i);
        const d = new Date(`${iso}T12:00:00Z`);
        days.push({
          iso,
          num: d.getUTCDate(),
          month: d.getUTCMonth(),
          weekend: isWeekend(iso),
          isToday: iso === today,
          isPast: iso < today,
        });
      }
      const m = days[0].month;
      const monthLabel = m !== lastMonth ? MONTHS[m] : null;
      lastMonth = m;
      rows.push({ key: days[0].iso, monthLabel, days });
    }
    return rows;
  }, [today, weeks]);

  function cellState(iso: string): CellState {
    const ov = overrides.get(iso);
    const inPat = pattern.includes(isoWeekday(iso));
    if (ov === "unavailable") return "off";
    if (ov === "available") return inPat ? "working" : "offered"; // an offer on a pattern day is redundant
    return inPat ? "working" : "rest";
  }

  async function togglePatternDay(iw: number) {
    if (patPending !== null) return;
    const has = pattern.includes(iw);
    const next = has ? pattern.filter((x) => x !== iw) : [...pattern, iw].sort((a, b) => a - b);
    const prev = pattern;
    setPattern(next);
    setPatPending(iw);
    // try/finally: a rejected server action (flaky mobile signal, or a stale
    // action id after a deploy) must still clear the pending flag — otherwise the
    // whole "normal week" row stays disabled forever with no toast (freeze).
    try {
      const r = await setMyWorkingDaysAction({ working_days: next });
      if (!r.ok) {
        setPattern(prev);
        toast.error(r.error);
      }
    } catch {
      setPattern(prev);
      toast.error("Couldn't save — check your connection and try again.");
    } finally {
      setPatPending(null);
    }
  }

  async function setDay(iso: string, status: "available" | "unavailable" | "clear") {
    if (pending.has(iso)) return;
    const hadPrev = overrides.has(iso);
    const prevVal = overrides.get(iso);
    setOverrides((m) => {
      const n = new Map(m);
      if (status === "clear") n.delete(iso);
      else n.set(iso, status);
      return n;
    });
    setPending((s) => new Set(s).add(iso));
    // Revert THIS day only (per-item, never a whole-collection snapshot).
    const revertThisDay = () =>
      setOverrides((m) => {
        const n = new Map(m);
        if (hadPrev) n.set(iso, prevVal!);
        else n.delete(iso);
        return n;
      });
    // try/finally so a rejected action always clears the day's pending flag —
    // else the cell stays disabled and its sheet can't be reopened (freeze).
    try {
      const r = await setMyAvailabilityAction({ date: iso, status });
      if (!r.ok) {
        revertThisDay();
        toast.error(r.error);
      }
    } catch {
      revertThisDay();
      toast.error("Couldn't save — check your connection and try again.");
    } finally {
      setPending((s) => {
        const n = new Set(s);
        n.delete(iso);
        return n;
      });
    }
  }

  const offeredCount = weekRows.flatMap((w) => w.days).filter((d) => !d.isPast && cellState(d.iso) === "offered").length;

  // sheet context
  const sd = sheetDate;
  const sdInfo = sd
    ? {
        inPat: pattern.includes(isoWeekday(sd)),
        state: cellState(sd),
        label: (() => {
          const d = new Date(`${sd}T12:00:00Z`);
          return `${d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
        })(),
      }
    : null;

  const CELL_META: Record<CellState, { cls: string; label: string }> = {
    working: { cls: "border-success/30 bg-success/10", label: "On" },
    off: { cls: "border-border bg-muted", label: "Off" },
    offered: { cls: "border-success bg-success text-white", label: "Offered" },
    rest: { cls: "border-border bg-card", label: "" },
  };

  return (
    <div>
      {/* 1 — the weekly pattern */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">My normal week</h2>
        <p className="mt-0.5 text-sm text-mist-400">
          Tap the days you usually work. You currently work{" "}
          <span className="font-semibold text-foreground">{patternLabel(pattern)}</span>.
        </p>
        <div className="mt-3 grid grid-cols-7 gap-1.5">
          {CHIPS.map((c) => {
            const on = pattern.includes(c.iw);
            const busy = patPending === c.iw;
            return (
              <button
                key={c.iw}
                type="button"
                aria-pressed={on}
                disabled={patPending !== null}
                onClick={() => togglePatternDay(c.iw)}
                className={cn(
                  "focus-ring flex h-12 items-center justify-center rounded-lg border text-sm font-semibold transition-colors",
                  on ? "border-mm-red bg-mm-red text-white" : "border-input bg-card text-mist-400 hover:bg-muted",
                  busy && "opacity-60",
                )}
              >
                {c.l}
              </button>
            );
          })}
        </div>
      </div>

      {/* 2 — the calendar */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-mist-400">Tap a day to change it</h2>
          {offeredCount > 0 ? (
            <span className="text-xs font-medium text-success">
              {offeredCount} extra day{offeredCount === 1 ? "" : "s"} offered
            </span>
          ) : null}
        </div>

        <div className="mt-3 grid grid-cols-7 gap-1.5 text-center">
          {CHIPS.map((c) => (
            <span key={c.iw} className="text-[10px] font-semibold uppercase tracking-wide text-mist-400">
              {c.l[0]}
            </span>
          ))}
        </div>

        {weekRows.map((wk) => (
          <div key={wk.key}>
            {wk.monthLabel ? (
              <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-mist-400">{wk.monthLabel}</p>
            ) : null}
            <div className="mt-1.5 grid grid-cols-7 gap-1.5">
              {wk.days.map((d) => {
                const st = cellState(d.iso);
                const meta = CELL_META[st];
                const busy = pending.has(d.iso);
                return (
                  <button
                    key={d.iso}
                    type="button"
                    disabled={d.isPast || busy}
                    onClick={() => setSheetDate(d.iso)}
                    aria-label={`${d.num} ${MONTHS[d.month]} — ${meta.label || "not working"}`}
                    className={cn(
                      "focus-ring flex aspect-square flex-col items-center justify-center gap-0.5 rounded-xl border transition-colors",
                      meta.cls,
                      d.weekend && st === "rest" && "bg-survey-bg/40",
                      d.isToday && "ring-2 ring-mm-red ring-offset-1 ring-offset-background",
                      d.isPast && "pointer-events-none opacity-35",
                      busy && "opacity-60",
                    )}
                  >
                    <span
                      className={cn(
                        "text-[15px] font-bold tabular leading-none",
                        st === "offered" ? "text-white" : st === "working" ? "text-success" : "text-foreground",
                      )}
                    >
                      {d.num}
                    </span>
                    {meta.label ? (
                      <span
                        className={cn(
                          "text-[8.5px] font-bold uppercase tracking-wide leading-none",
                          st === "offered" ? "text-white/90" : st === "working" ? "text-success" : "text-mist-400",
                        )}
                      >
                        {meta.label}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-mist-400">
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-success/30 bg-success/10" />On
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-border bg-muted" />Day off
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border border-success bg-success" />Offered
          </span>
        </div>
      </div>

      {/* bottom sheet */}
      {sd && sdInfo ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setSheetDate(null)}
            className="absolute inset-0 bg-black/45"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-card p-4 pb-6 shadow-[0_-12px_40px_-18px_rgba(0,0,0,0.5)]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
            <h3 className="font-display text-xl font-semibold text-foreground">{sdInfo.label}</h3>
            <p className="mt-0.5 text-sm text-mist-400">
              {sdInfo.inPat
                ? sdInfo.state === "off"
                  ? "You've booked this day off."
                  : "One of your normal working days."
                : "Not one of your normal days — offer it if you can work."}
            </p>

            <div className="mt-4 space-y-2.5">
              {sdInfo.inPat ? (
                sdInfo.state === "off" ? (
                  <>
                    <FatButton variant="primary" onClick={() => (setDay(sd, "clear"), setSheetDate(null))}>
                      Back to working
                    </FatButton>
                    <FatButton variant="ghost" onClick={() => setSheetDate(null)}>
                      Keep day off
                    </FatButton>
                  </>
                ) : (
                  <>
                    <FatButton variant="outline" onClick={() => (setDay(sd, "unavailable"), setSheetDate(null))}>
                      Book day off
                    </FatButton>
                    <FatButton variant="ghost" onClick={() => setSheetDate(null)}>
                      Keep working
                    </FatButton>
                  </>
                )
              ) : sdInfo.state === "offered" ? (
                <>
                  <FatButton variant="outline" onClick={() => (setDay(sd, "clear"), setSheetDate(null))}>
                    Cancel the offer
                  </FatButton>
                  <FatButton variant="ghost" onClick={() => setSheetDate(null)}>
                    Keep it offered
                  </FatButton>
                </>
              ) : (
                <>
                  <FatButton variant="good" onClick={() => (setDay(sd, "available"), setSheetDate(null))}>
                    Offer to work
                  </FatButton>
                  <FatButton variant="ghost" onClick={() => setSheetDate(null)}>
                    Leave it
                  </FatButton>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FatButton({
  variant,
  onClick,
  children,
}: {
  variant: "primary" | "good" | "outline" | "ghost";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring flex min-h-14 w-full items-center justify-center rounded-xl text-[15px] font-semibold transition-colors",
        variant === "primary" && "bg-mm-red text-white hover:bg-mm-red-deep",
        variant === "good" && "bg-success text-white hover:opacity-90",
        variant === "outline" && "border border-input bg-card text-foreground hover:bg-muted",
        variant === "ghost" && "text-mist-500 hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
