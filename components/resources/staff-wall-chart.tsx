"use client";

/**
 * Office team wall chart (Timetastic-style) — every active crew member as a row,
 * a fortnight across the top, colour-coded cells for who's working / off /
 * offered a non-pattern day. Tap a cell to amend that day; the strip along the
 * bottom is live crew coverage per day (the Job-Board payoff). Reads each staff
 * member's weekly pattern (working_days) so a casual's rest days and a retained
 * crew member's Mon–Fri both read correctly.
 */

import { useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, Minus, Pencil, Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DEFAULT_WORKING_DAYS, isoWeekday, isWeekend, patternLabel } from "@/lib/staff/availability";
import { setStaffAvailabilityCellAction } from "@/app/(dashboard)/resources/actions";

interface WallStaff {
  id: string;
  full_name: string;
  staff_role: string;
  working_days: number[] | null;
}
interface WallAvailRow {
  id: string;
  staff_id: string;
  date: string;
  status: string;
  note: string | null;
}

type CellState = "working" | "off" | "offered" | "rest";

const DOW = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FORTNIGHT = 14;

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
function fmtShort(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function StaffWallChart({
  staff,
  staffAvailability,
  today,
  isAdmin,
  onEditStaff,
}: {
  staff: WallStaff[];
  staffAvailability: WallAvailRow[];
  today: string;
  /** Editing the staff RECORD (name/pattern/pay) is admin-only; a non-admin can
   *  still change per-day availability via the cells. */
  isAdmin: boolean;
  onEditStaff: (id: string) => void;
}) {
  const [weekStart, setWeekStart] = useState<string>(() => mondayOf(today));
  const [overrides, setOverrides] = useState<Map<string, { status: "available" | "unavailable"; note: string | null }>>(
    () => {
      const m = new Map<string, { status: "available" | "unavailable"; note: string | null }>();
      for (const a of staffAvailability) {
        if (a.status === "available" || a.status === "unavailable") {
          m.set(`${a.staff_id}|${a.date.slice(0, 10)}`, { status: a.status, note: a.note });
        }
      }
      return m;
    },
  );
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ staffId: string; staffName: string; date: string } | null>(null);
  const [noteInput, setNoteInput] = useState("");

  const days = useMemo(() => {
    return Array.from({ length: FORTNIGHT }, (_, i) => {
      const iso = addDays(weekStart, i);
      const d = new Date(`${iso}T12:00:00Z`);
      return {
        iso,
        num: d.getUTCDate(),
        dow: DOW[isoWeekday(iso)],
        weekend: isWeekend(iso),
        isToday: iso === today,
        isPast: iso < today,
      };
    });
  }, [weekStart, today]);

  const patternOf = (s: WallStaff): readonly number[] => s.working_days ?? DEFAULT_WORKING_DAYS;

  function cellState(s: WallStaff, iso: string): CellState {
    const ov = overrides.get(`${s.id}|${iso}`);
    const inPat = patternOf(s).includes(isoWeekday(iso));
    if (ov?.status === "unavailable") return "off";
    if (ov?.status === "available") return inPat ? "working" : "offered";
    return inPat ? "working" : "rest";
  }

  // Availability capacity for a day: `usable` = crew rostered/offered that day
  // (exclude their rest days), `free` = those actually available (working or
  // offered). Mirrors the Job Board's usableStaff so a low-roster day (one
  // weekend volunteer) reads 1/1 green, not 1/4 amber.
  function dayCounts(iso: string): { free: number; usable: number } {
    let free = 0;
    let usable = 0;
    for (const s of staff) {
      const st = cellState(s, iso);
      if (st !== "rest") usable++;
      if (st === "working" || st === "offered") free++;
    }
    return { free, usable };
  }

  async function setCell(staffId: string, date: string, status: "available" | "unavailable" | "clear", note: string) {
    const key = `${staffId}|${date}`;
    if (pending.has(key)) return;
    const hadPrev = overrides.has(key);
    const prevVal = overrides.get(key);
    setOverrides((m) => {
      const n = new Map(m);
      if (status === "clear") n.delete(key);
      else n.set(key, { status, note: note || null });
      return n;
    });
    setPending((s) => new Set(s).add(key));
    setEditing(null);
    const r = await setStaffAvailabilityCellAction({ staff_id: staffId, date, status, note });
    setPending((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });
    if (!r.ok) {
      setOverrides((m) => {
        const n = new Map(m);
        if (hadPrev) n.set(key, prevVal!);
        else n.delete(key);
        return n;
      });
      toast.error(r.error);
    }
  }

  const editInfo = editing
    ? {
        inPat: (() => {
          const s = staff.find((x) => x.id === editing.staffId);
          return s ? patternOf(s).includes(isoWeekday(editing.date)) : true;
        })(),
        weekday: (() => {
          const d = new Date(`${editing.date}T12:00:00Z`);
          return d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
        })(),
      }
    : null;

  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous fortnight"
            onClick={() => setWeekStart((w) => addDays(w, -FORTNIGHT))}
            className="focus-ring flex size-9 items-center justify-center rounded-md border border-border bg-card text-mist-500 hover:border-mm-red/40 hover:text-mm-red"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </button>
          <span className="min-w-[9.5rem] text-center font-display text-lg font-semibold text-foreground">
            {fmtShort(days[0].iso)} – {fmtShort(days[FORTNIGHT - 1].iso)}
          </span>
          <button
            type="button"
            aria-label="Next fortnight"
            onClick={() => setWeekStart((w) => addDays(w, FORTNIGHT))}
            className="focus-ring flex size-9 items-center justify-center rounded-md border border-border bg-card text-mist-500 hover:border-mm-red/40 hover:text-mm-red"
          >
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </button>
          {weekStart !== mondayOf(today) ? (
            <button
              type="button"
              onClick={() => setWeekStart(mondayOf(today))}
              className="focus-ring rounded-md px-2.5 py-1.5 text-sm font-medium text-mist-500 hover:bg-muted hover:text-foreground"
            >
              Today
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mist-400">
          <span className="flex items-center gap-1.5">
            <span className="flex size-3.5 items-center justify-center rounded border border-success/30 bg-success/10 text-success">
              <Check className="size-2.5" strokeWidth={3} />
            </span>
            Working
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex size-3.5 items-center justify-center rounded border border-border bg-muted text-mist-500">
              <Minus className="size-2.5" strokeWidth={3} />
            </span>
            Off
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex size-3.5 items-center justify-center rounded border border-success bg-success text-white">
              <Star className="size-2.5" strokeWidth={2.5} />
            </span>
            Offered
          </span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <div
          className="grid min-w-[820px] text-sm"
          style={{ gridTemplateColumns: `170px repeat(${FORTNIGHT}, minmax(42px, 1fr))` }}
        >
          {/* header */}
          <div className="sticky left-0 z-20 border-b border-r border-border bg-card" />
          {days.map((d) => (
            <div
              key={d.iso}
              className={cn(
                "border-b border-r border-border py-1.5 text-center",
                d.weekend ? "bg-muted/70" : "bg-muted/30",
                d.isToday && "border-t-2 border-t-mm-red",
              )}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide text-mist-400">{d.dow}</div>
              <div className={cn("text-sm font-semibold tabular", d.isToday ? "text-mm-red" : "text-foreground")}>
                {d.num}
              </div>
            </div>
          ))}

          {/* rows */}
          {staff.map((s) => (
            <StaffWallRow
              key={s.id}
              s={s}
              days={days}
              patternLabel={patternLabel(patternOf(s))}
              cellState={(iso) => cellState(s, iso)}
              noteOf={(iso) => overrides.get(`${s.id}|${iso}`)?.note ?? null}
              pendingOn={(iso) => pending.has(`${s.id}|${iso}`)}
              onTapCell={(iso) => {
                setNoteInput(overrides.get(`${s.id}|${iso}`)?.note ?? "");
                setEditing({ staffId: s.id, staffName: s.full_name, date: iso });
              }}
              onEdit={isAdmin ? () => onEditStaff(s.id) : undefined}
            />
          ))}

          {/* capacity */}
          <div className="sticky left-0 z-20 border-r border-border bg-card px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-mist-400">
            Available
          </div>
          {days.map((d) => {
            const { free, usable } = dayCounts(d.iso);
            const cls = free === 0 ? "text-danger" : free < usable ? "text-warn" : "text-success";
            return (
              <div
                key={d.iso}
                className={cn("border-r border-border py-2 text-center", d.weekend && "bg-muted/60")}
              >
                <span className={cn("text-xs font-bold tabular", cls)}>
                  {free}/{usable}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* per-cell edit sheet */}
      {editing && editInfo ? (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setEditing(null)}
            className="absolute inset-0 bg-black/45"
          />
          <div className="absolute left-1/2 top-1/2 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-5 shadow-xl">
            <p className="text-xs font-semibold uppercase tracking-wide text-mist-400">
              {editing.staffName}
            </p>
            <h3 className="mt-0.5 font-display text-xl font-semibold text-foreground">
              {editInfo.weekday} {fmtShort(editing.date)}
            </h3>
            <p className="mt-0.5 text-sm text-mist-400">
              {editInfo.inPat ? "A normal working day for them." : "Not one of their normal days."}
            </p>

            <label className="mt-4 block text-xs font-medium text-mist-500">Reason / note (optional)</label>
            <input
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Holiday, appointment…"
              className="focus-ring mt-1 h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
            />

            <div className="mt-4 space-y-2.5">
              {editInfo.inPat ? (
                <>
                  <WallBtn variant="outline" onClick={() => setCell(editing.staffId, editing.date, "unavailable", noteInput)}>
                    Book day off
                  </WallBtn>
                  <WallBtn variant="primary" onClick={() => setCell(editing.staffId, editing.date, "clear", "")}>
                    Working (clear override)
                  </WallBtn>
                </>
              ) : (
                <>
                  <WallBtn variant="good" onClick={() => setCell(editing.staffId, editing.date, "available", noteInput)}>
                    Offer / available
                  </WallBtn>
                  <WallBtn variant="primary" onClick={() => setCell(editing.staffId, editing.date, "clear", "")}>
                    Not working (clear)
                  </WallBtn>
                </>
              )}
              <WallBtn variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </WallBtn>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StaffWallRow({
  s,
  days,
  patternLabel: pat,
  cellState,
  noteOf,
  pendingOn,
  onTapCell,
  onEdit,
}: {
  s: WallStaff;
  days: { iso: string; weekend: boolean; isToday: boolean; isPast: boolean }[];
  patternLabel: string;
  cellState: (iso: string) => CellState;
  noteOf: (iso: string) => string | null;
  pendingOn: (iso: string) => boolean;
  onTapCell: (iso: string) => void;
  /** undefined for non-admins → the row header renders read-only (name/pattern
   *  only, no edit affordance); availability cells stay editable regardless. */
  onEdit?: () => void;
}) {
  const META: Record<CellState, { cls: string; icon: React.ReactNode }> = {
    working: { cls: "border-success/30 bg-success/10 text-success", icon: <Check className="size-3.5" strokeWidth={3} /> },
    off: { cls: "border-border bg-muted text-mist-500", icon: <Minus className="size-3.5" strokeWidth={3} /> },
    offered: { cls: "border-success bg-success text-white", icon: <Star className="size-3.5" strokeWidth={2.5} /> },
    rest: { cls: "border-transparent text-transparent", icon: null },
  };
  return (
    <>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="focus-ring sticky left-0 z-10 flex items-center justify-between gap-2 border-b border-r border-border bg-card px-3 py-2 text-left hover:bg-muted/50"
          title="Edit staff, pattern and holidays"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">{s.full_name}</span>
            <span className="block truncate text-[11px] text-mist-400">{pat}</span>
          </span>
          <Pencil className="size-3.5 shrink-0 text-mist-300" strokeWidth={1.75} />
        </button>
      ) : (
        <div className="sticky left-0 z-10 flex items-center justify-between gap-2 border-b border-r border-border bg-card px-3 py-2 text-left">
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">{s.full_name}</span>
            <span className="block truncate text-[11px] text-mist-400">{pat}</span>
          </span>
        </div>
      )}
      {days.map((d) => {
        const st = cellState(d.iso);
        const meta = META[st];
        const busy = pendingOn(d.iso);
        const note = st === "off" ? noteOf(d.iso) : null;
        return (
          <div
            key={d.iso}
            className={cn("relative border-b border-r border-border p-1", d.weekend && st === "rest" && "bg-muted/40")}
          >
            <button
              type="button"
              disabled={d.isPast || busy}
              onClick={() => onTapCell(d.iso)}
              title={note ?? undefined}
              aria-label={`${s.full_name} ${d.iso} — ${st}`}
              className={cn(
                "flex aspect-square w-full items-center justify-center rounded-md border transition-transform hover:scale-[1.06]",
                meta.cls,
                d.isPast && "pointer-events-none opacity-30",
                busy && "opacity-50",
              )}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin text-mist-400" strokeWidth={2} /> : meta.icon}
            </button>
            {note ? <span className="pointer-events-none absolute right-1.5 top-1.5 size-1.5 rounded-full bg-mm-red" /> : null}
          </div>
        );
      })}
    </>
  );
}

function WallBtn({
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
        "focus-ring flex min-h-12 w-full items-center justify-center rounded-xl text-sm font-semibold transition-colors",
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
