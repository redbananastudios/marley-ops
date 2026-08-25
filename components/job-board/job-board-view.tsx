"use client";

/**
 * Job Board — the week's jobs with per-day resource capacity and assignment
 * (iMVE clone-and-improve, docs/imve-discovery.md §1). Improvements over iMVE:
 * clash WARNING on assign (they double-book silently), vehicle compliance badge
 * on the chip, and required-vs-assigned crew derived from the accepted quote.
 * Assign works by modal (the iPad-reliable path) AND by dragging a resource
 * from the rail onto a job card (the desktop nicety).
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarRange,
  CarFront,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldAlert,
  Truck,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { JobSheetButton } from "@/components/job-sheet-button";
import { LEAD_STATUS_META } from "@/components/lead-status-badge";
import { BrandChip, type BrandChipData } from "@/components/brand/brand-chip";
import {
  apptDays,
  apptWindow,
  clashesFor,
  resourceDayState,
  type ApptLite,
  type DayState,
} from "@/lib/job-board";
import { vehicleNeedsAttention } from "@/lib/vehicles";
import { vehicleOffRoad, type UnavailabilityWindow } from "@/lib/fleet/availability";
import { staffOffOn, type AvailabilityRow } from "@/lib/staff/availability";
import { needsDriverWarning } from "@/lib/schedule/capacity";
import {
  assignResourceAction,
  setAssignmentsAction,
  unassignAction,
} from "@/app/actions/board-allocation";

export interface BoardAppt extends ApptLite {
  title: string | null;
  appt_type: string;
  /** Brand slug (appointments.brand, denormalised from the lead — multi-brand
   *  PRD §3.2) — resolved to chip data via the caller's active-brand list.
   *  Optional so pre-brand callers keep compiling; absent → no chip. */
  brand?: string | null;
  lead_id: string | null;
  lead_name: string | null;
  lead_status: string | null;
  from_postcode: string | null;
  to_postcode: string | null;
  required: { vans: number; men: number } | null;
  /** Accepted quote with no contract signature — crew collect on arrival. */
  sigNeeded: boolean;
}

export interface BoardStaff {
  id: string;
  full_name: string;
  staff_role: string;
  working_days: number[] | null;
  /** Can take a van out (design §D12). Warn-only when a van has no driver. */
  is_driver?: boolean;
}

export interface BoardVehicle {
  id: string;
  name: string;
  vehicle_type: string;
  registration: string;
  tax_due: string | null;
  mot_due: string | null;
  insurance_renewal: string | null;
  service_due: string | null;
  end_of_term: string | null;
}

export interface BoardAssignment {
  id: string;
  appointment_id: string;
  staff_id: string | null;
  vehicle_id: string | null;
}

export interface BoardUnavailability {
  vehicle_id: string;
  start_date: string;
  end_date: string;
  reason: string;
}

export interface BoardStaffAvailability {
  staff_id: string;
  date: string;
  status: string;
  note: string | null;
}

type Resource = { kind: "staff" | "vehicle"; id: string; name: string };
const DND_MIME = "application/x-mm-resource";

/** yyyy-mm-dd ± n days (UTC-safe — pure date strings). */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekLabel(start: string): string {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${addDays(start, 6)}T00:00:00Z`);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  const sameMonth = s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
  const from = sameMonth ? String(s.getUTCDate()) : s.toLocaleDateString("en-GB", opts);
  return `${from} – ${e.toLocaleDateString("en-GB", { ...opts, year: "numeric" })}`;
}

function dayHeading(iso: string): { dow: string; date: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    dow: d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
    date: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
  };
}

const STATE_META: Record<DayState, { label: string; cls: string }> = {
  free: { label: "Free", cls: "bg-success-bg text-success" },
  partial: { label: "Part busy", cls: "bg-warn-bg text-warn" },
  booked: { label: "Booked", cls: "bg-danger-bg text-danger" },
};
/** A resource that can't be used that day — a van off the road (garage window or
 *  an overdue legal doc) or a crew member not working. NOT counted as free
 *  capacity; the popover shows why. */
const UNAVAIL_META = { label: "Off", cls: "bg-muted text-mist-500" };
type CapRow = {
  id: string;
  name: string;
  state: DayState | "unavailable";
  windows: string[];
  unavailReason: string | null;
};

export function JobBoardView({
  appts,
  staff,
  vehicles,
  assignments,
  unavailability,
  staffAvailability,
  thisWeekStart,
  initialWeekStart,
  today,
  hideSurveys,
  brands = [],
  showBrandChips = false,
  brandFilter = "all",
}: {
  appts: BoardAppt[];
  staff: BoardStaff[];
  vehicles: BoardVehicle[];
  assignments: BoardAssignment[];
  unavailability: BoardUnavailability[];
  staffAvailability: BoardStaffAvailability[];
  thisWeekStart: string;
  /** Week the board opens on (?week= deep link); "This week" still resets to thisWeekStart. */
  initialWeekStart?: string;
  today: string;
  /** Hide surveys entirely + the Surveys toggle (Schedule & Allocation's Day Allocation is moves-only). */
  hideSurveys?: boolean;
  /** Active brands (multi-brand PRD §4 /schedule) — chip data only; the
   *  segmented filter lives with the embedding page. Empty or single-entry →
   *  no brand UI renders (the single-brand invariant, PRD §1). Mirrors the
   *  StatusBoard wiring from gate 3. */
  brands?: BrandChipData[];
  /** True only in multi-brand mode with the ?brand= filter on All — the chip is
   *  hidden when the segmented control already names a single brand. */
  showBrandChips?: boolean;
  /** `'all'` or an active brand slug (validated server-side via parseBrandParam).
   *  Narrows the VISIBLE cards only — the capacity strips and clash detection
   *  deliberately keep every brand's jobs, because crew and vans are one shared
   *  pool: a filtered board must still count a resource as taken (and warn on
   *  assign) when the other brand's job has it. */
  brandFilter?: string;
}) {
  const router = useRouter();
  const [weekStart, setWeekStart] = useState(initialWeekStart ?? thisWeekStart);
  // Follow ?week= deep links even when the board is ALREADY mounted: a
  // same-route router.push (e.g. the deposit toast's "Assign crew" clicked
  // while sitting on the board) re-renders with a new prop but never re-runs
  // the useState initializer, so without this the deep link is silently
  // ignored. In-board arrows only touch local state, so they're unaffected.
  useEffect(() => {
    if (initialWeekStart) setWeekStart(initialWeekStart);
  }, [initialWeekStart]);
  const [showSurveys, setShowSurveys] = useState(true);
  const [railOpen, setRailOpen] = useState(true);
  const [assignFor, setAssignFor] = useState<BoardAppt | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ appt: BoardAppt; res: Resource; clashLabels: string[] } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const brandBySlug = useMemo(() => new Map(brands.map((b) => [b.slug, b])), [brands]);
  const apptById = useMemo(() => new Map<string, ApptLite>(appts.map((a) => [a.id, a])), [appts]);
  const cardById = useMemo(() => new Map(appts.map((a) => [a.id, a])), [appts]);
  const byAppt = useMemo(() => {
    const m = new Map<string, BoardAssignment[]>();
    for (const as of assignments) {
      const list = m.get(as.appointment_id) ?? [];
      list.push(as);
      m.set(as.appointment_id, list);
    }
    return m;
  }, [assignments]);
  const unavailByVehicle = useMemo(() => {
    const m = new Map<string, UnavailabilityWindow[]>();
    for (const u of unavailability) {
      const list = m.get(u.vehicle_id) ?? [];
      list.push({ start_date: u.start_date, end_date: u.end_date, reason: u.reason });
      m.set(u.vehicle_id, list);
    }
    return m;
  }, [unavailability]);
  const availByStaff = useMemo(() => {
    const m = new Map<string, AvailabilityRow[]>();
    for (const a of staffAvailability) {
      const list = m.get(a.staff_id) ?? [];
      list.push({ date: a.date, status: a.status as "available" | "unavailable", note: a.note });
      m.set(a.staff_id, list);
    }
    return m;
  }, [staffAvailability]);
  const daysByAppt = useMemo(() => new Map(appts.map((a) => [a.id, apptDays(a)])), [appts]);

  const cardsForDay = (day: string) =>
    appts
      .filter(
        (a) =>
          ((showSurveys && !hideSurveys) || a.appt_type !== "survey") &&
          // Brand narrowing hides CARDS only — capacity/clash maps above keep
          // the full set (shared crew/van pool, see the brandFilter prop).
          (brandFilter === "all" || a.brand === brandFilter) &&
          (daysByAppt.get(a.id) ?? []).includes(day),
      )
      .sort((a, b) => Number(b.all_day) - Number(a.all_day) || (a.starts_at ?? "").localeCompare(b.starts_at ?? ""));

  /** "John Farnell (All day, Mon 13 Jul)" labels for clash messages. */
  function clashLabels(clashes: ApptLite[]): string[] {
    return clashes.map((c) => {
      const card = cardById.get(c.id);
      const who = card?.lead_name ?? card?.title ?? "another job";
      const firstDay = (daysByAppt.get(c.id) ?? apptDays(c))[0];
      const when = firstDay
        ? new Date(`${firstDay}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
        : "";
      return `${who} — ${apptWindow(c)}${when ? `, ${when}` : ""}`;
    });
  }

  function handleDrop(appt: BoardAppt, res: Resource) {
    const clashes = clashesFor(res.id, res.kind, appt, assignments, apptById);
    if (clashes.length) {
      setPendingDrop({ appt, res, clashLabels: clashLabels(clashes) });
      return;
    }
    void doAssign(appt, res);
  }

  async function doAssign(appt: BoardAppt, res: Resource) {
    try {
      const r = await assignResourceAction(appt.id, { kind: res.kind, id: res.id });
      if (!r.ok) toast.error(r.error);
      else {
        toast.success("already" in r && r.already ? `${res.name} was already on this job.` : `${res.name} assigned.`);
      }
    } catch {
      // A rejected action may still have COMMITTED (e.g. a post-write notify threw)
      // — refresh so the board shows the DB truth rather than a stale drag.
      toast.error("Couldn't confirm the assignment — refreshing the board.");
    } finally {
      router.refresh();
    }
  }

  // One day's column of jobs. Rendered as a fixed-width kanban cell on desktop
  // (≥lg) and as a full-width row in the stacked list on tablet/phone (<lg). In
  // `stacked` mode it sizes to its content (no forced min-height) so empty days
  // stay compact and the whole week fits a vertical scroll instead of a
  // pan-and-hunt horizontal one. Assignment is modal-only below lg (the drag
  // rail is desktop-only), which already works on touch.
  const renderDay = (day: string, stacked: boolean) => {
    const heading = dayHeading(day);
    const isToday = day === today;
    const cards = cardsForDay(day);
    return (
      <div
        key={day}
        className={cn(
          "flex flex-col rounded-lg border bg-mist-50/50",
          // Today = a solid red top rail + red frame, not a pink wash — the
          // column surface stays clean so job cards keep full contrast.
          isToday ? "border-mm-red/45 border-t-[3px] border-t-mm-red" : "border-border",
          stacked ? "" : "min-h-[320px]",
        )}
      >
        <div className="rounded-t-lg border-b border-border bg-card px-2.5 py-2">
          <div className="flex items-center justify-between">
            <p className={cn("text-sm font-semibold", isToday ? "text-mm-red" : "text-foreground")}>
              {heading.dow}
            </p>
            {isToday ? (
              <p className="rounded-pill bg-mm-red px-2 py-0.5 text-[11px] font-semibold leading-none text-white">
                {heading.date}
              </p>
            ) : (
              <p className="text-xs text-mist-400">{heading.date}</p>
            )}
          </div>
          <CapacityStrip
            day={day}
            staff={staff}
            vehicles={vehicles}
            assignments={assignments}
            apptById={apptById}
            unavailByVehicle={unavailByVehicle}
            availByStaff={availByStaff}
          />
        </div>

        <div className="flex flex-1 flex-col gap-2 p-2">
          {cards.length === 0 ? (
            <p className="py-6 text-center text-xs text-mist-300">No jobs</p>
          ) : (
            cards.map((a) => (
              <JobCard
                key={`${a.id}:${day}`}
                appt={a}
                brand={showBrandChips && a.brand ? (brandBySlug.get(a.brand) ?? null) : null}
                multiDay={(daysByAppt.get(a.id) ?? []).length > 1}
                assigned={byAppt.get(a.id) ?? []}
                staff={staff}
                vehicles={vehicles}
                highlight={dropTarget === `${a.id}:${day}`}
                onDragOverChange={(on) => setDropTarget(on ? `${a.id}:${day}` : null)}
                onDropResource={(res) => handleDrop(a, res)}
                onAssign={() => setAssignFor(a)}
              />
            ))
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-1 flex-col">
      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-stretch overflow-hidden rounded-md border border-input bg-card">
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            aria-label="Previous week"
            className="focus-ring flex min-h-9 w-9 items-center justify-center text-mist-400 transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(thisWeekStart)}
            title="Back to this week"
            className="focus-ring min-w-[136px] border-x border-input px-3 text-sm font-medium tabular text-foreground transition-colors hover:bg-muted"
          >
            {weekLabel(weekStart)}
          </button>
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            aria-label="Next week"
            className="focus-ring flex min-h-9 w-9 items-center justify-center text-mist-400 transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        {!hideSurveys ? (
          <button
            type="button"
            onClick={() => setShowSurveys((v) => !v)}
            aria-pressed={showSurveys}
            className={cn(
              "focus-ring min-h-9 rounded-md border border-input px-3 text-sm font-medium transition-colors",
              showSurveys ? "border-mm-red bg-mm-red text-white" : "bg-card text-mist-500 hover:bg-muted",
            )}
          >
            Surveys
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setRailOpen((v) => !v)}
          aria-pressed={railOpen}
          title={railOpen ? "Hide resources" : "Show resources"}
          className="focus-ring ml-auto hidden min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-mist-500 transition-colors hover:bg-muted lg:inline-flex"
        >
          {railOpen ? (
            <PanelLeftClose className="size-4" strokeWidth={1.75} />
          ) : (
            <PanelLeftOpen className="size-4" strokeWidth={1.75} />
          )}
          Resources
        </button>
      </div>

      <div className="flex flex-1 gap-4">
        {/* resource rail — drag a chip onto a job (desktop) */}
        {railOpen ? (
          <aside className="hidden w-52 shrink-0 lg:block">
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="eyebrow pb-2">Staff</p>
              <div className="space-y-1">
                {staff.length === 0 ? (
                  <RailEmpty href="/resources" label="Add staff" />
                ) : (
                  staff.map((s) => (
                    <RailChip
                      key={s.id}
                      res={{ kind: "staff", id: s.id, name: s.full_name }}
                      sub={s.staff_role}
                      driver={s.is_driver}
                    />
                  ))
                )}
              </div>
              <p className="eyebrow pb-2 pt-4">Vehicles</p>
              <div className="space-y-1">
                {vehicles.length === 0 ? (
                  <RailEmpty href="/resources?tab=vehicles" label="Add vehicles" />
                ) : (
                  vehicles.map((v) => (
                    <RailChip
                      key={v.id}
                      res={{ kind: "vehicle", id: v.id, name: v.name }}
                      sub={v.registration || v.vehicle_type}
                      warn={vehicleNeedsAttention(v)}
                    />
                  ))
                )}
              </div>
              <p className="mt-4 border-t border-border pt-2 text-[11px] leading-snug text-mist-400">
                Drag onto a job, or use Assign on the card.
              </p>
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-mist-400">
                <span className="flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-foreground text-card">
                  <CarFront className="size-2.5" strokeWidth={1.75} />
                </span>
                <span>Driver — can take a van out</span>
              </div>
            </div>
          </aside>
        ) : null}

        {/* week grid — desktop kanban (≥lg): 7 fixed columns, drag rail active */}
        <div className="hidden min-w-0 flex-1 overflow-x-auto pb-2 lg:block">
          <div className="grid min-w-[1190px] grid-cols-7 gap-2">
            {days.map((day) => renderDay(day, false))}
          </div>
        </div>

        {/* stacked day list — tablet/phone (<lg): vertical scroll, modal assign */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 pb-2 lg:hidden">
          {days.map((day) => renderDay(day, true))}
        </div>
      </div>

      {assignFor ? (
        <AssignDialog
          appt={assignFor}
          staff={staff}
          vehicles={vehicles}
          assignments={assignments}
          apptById={apptById}
          unavailByVehicle={unavailByVehicle}
          availByStaff={availByStaff}
          clashLabels={clashLabels}
          onClose={() => setAssignFor(null)}
        />
      ) : null}

      {pendingDrop ? (
        <Dialog open onOpenChange={(o) => !o && setPendingDrop(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display text-xl">Already booked</DialogTitle>
              <DialogDescription>
                {pendingDrop.res.name} is already on:{" "}
                {pendingDrop.clashLabels.join("; ")}. Assign anyway?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingDrop(null)}>
                Cancel
              </Button>
              <Button
                className="bg-mm-red text-white hover:bg-mm-red-deep"
                onClick={() => {
                  const p = pendingDrop;
                  setPendingDrop(null);
                  if (p) void doAssign(p.appt, p.res);
                }}
              >
                Assign anyway
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function RailEmpty({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="focus-ring block rounded-md px-2 py-1.5 text-xs text-mist-400 underline-offset-2 hover:underline">
      {label} →
    </Link>
  );
}

function RailChip({
  res,
  sub,
  warn,
  driver,
}: {
  res: Resource;
  sub: string;
  warn?: boolean;
  driver?: boolean;
}) {
  // Icon-tile colour tells the resource apart at a glance: a van carries the
  // Marley-red tint, a driver gets a filled-charcoal tile (plus the CarFront
  // mark on the right), and ordinary crew stay muted.
  const isVehicle = res.kind === "vehicle";
  const TileIcon = isVehicle ? Truck : UserRound;
  const tileCls = isVehicle
    ? "bg-mm-red-tint text-mm-red-deep"
    : driver
      ? "bg-foreground text-card"
      : "bg-muted text-mist-400";
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MIME, JSON.stringify(res));
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={`Drag ${res.name} onto a job`}
      className={cn(
        "flex cursor-grab items-center gap-2 rounded-md border bg-card px-2 py-1.5 active:cursor-grabbing",
        // A driver frames slightly stronger than ordinary crew/vans so it pops.
        driver ? "border-mist-400/60" : "border-border",
      )}
    >
      <GripVertical className="size-3.5 shrink-0 text-mist-300" strokeWidth={1.75} />
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", tileCls)}>
        <TileIcon className="size-3.5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{res.name}</span>
        <span className="block truncate text-[10px] capitalize text-mist-400">{sub}</span>
      </span>
      {driver ? <CarFront className="size-3.5 shrink-0 text-foreground" strokeWidth={1.75} /> : null}
      {warn ? <ShieldAlert className="size-3.5 shrink-0 text-warn" strokeWidth={2} /> : null}
    </div>
  );
}

/** "2 crew · 1 van free" per day, with a popover listing every resource's state. */
function CapacityStrip({
  day,
  staff,
  vehicles,
  assignments,
  apptById,
  unavailByVehicle,
  availByStaff,
}: {
  day: string;
  staff: BoardStaff[];
  vehicles: BoardVehicle[];
  assignments: BoardAssignment[];
  apptById: Map<string, ApptLite>;
  unavailByVehicle: Map<string, UnavailabilityWindow[]>;
  availByStaff: Map<string, AvailabilityRow[]>;
}) {
  const rows = useMemo(() => {
    const stateOf = (id: string, kind: "staff" | "vehicle") => {
      const key = kind === "staff" ? "staff_id" : "vehicle_id";
      const assigned: ApptLite[] = [];
      for (const as of assignments) {
        if (as[key] !== id) continue;
        const a = apptById.get(as.appointment_id);
        if (a) assigned.push(a);
      }
      const busyToday = assigned.filter((a) => apptDays(a).includes(day));
      return { state: resourceDayState(day, assigned), windows: busyToday.map(apptWindow) };
    };
    // Not working wins over the assignment state (mirrors off-road vans): a crew
    // member off that day — a booked day off, or a weekend they haven't offered
    // — is simply not available and never counts as free.
    const staffRows: CapRow[] = staff.map((s) => {
      const off = staffOffOn(availByStaff.get(s.id) ?? [], day, s.working_days ?? undefined);
      if (off.off) return { id: s.id, name: s.full_name, state: "unavailable", windows: [], unavailReason: off.reason };
      return { id: s.id, name: s.full_name, unavailReason: null, ...stateOf(s.id, "staff") };
    });
    // Off-road wins over the assignment state: a van in the garage or with an
    // overdue legal doc is simply not available, and never counts as free.
    const vehicleRows: CapRow[] = vehicles.map((v) => {
      const off = vehicleOffRoad(v, unavailByVehicle.get(v.id) ?? [], day);
      if (off.offRoad) return { id: v.id, name: v.name, state: "unavailable", windows: [], unavailReason: off.reason };
      return { id: v.id, name: v.name, unavailReason: null, ...stateOf(v.id, "vehicle") };
    });
    return { staff: staffRows, vehicles: vehicleRows };
  }, [day, staff, vehicles, assignments, apptById, unavailByVehicle, availByStaff]);

  const freeStaff = rows.staff.filter((r) => r.state === "free").length;
  const freeVans = rows.vehicles.filter((r) => r.state === "free").length;
  // Unavailable resources can't be booked, so they leave the USABLE count
  // entirely (numerator and denominator) — a day where every usable van is free
  // reads "3/3 free" (green), not a misleading amber "3/4". Same for crew who
  // aren't working that day.
  const usableStaff = rows.staff.filter((r) => r.state !== "unavailable").length;
  const usableVans = rows.vehicles.filter((r) => r.state !== "unavailable").length;

  // Traffic-light availability: everyone free = green, some committed = amber,
  // none left = red. Reads at a glance across the whole week.
  const tone = (free: number, total: number) =>
    total === 0
      ? "text-mist-400"
      : free === 0
        ? "text-danger"
        : free < total
          ? "text-warn"
          : "text-success";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Who's free this day"
          className="focus-ring mt-1.5 flex w-full items-center gap-2 rounded-md bg-muted/70 px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-muted"
        >
          <span className={cn("inline-flex items-center gap-1 tabular", tone(freeStaff, usableStaff))}>
            <UsersRound className="size-3.5" strokeWidth={1.75} />
            {freeStaff}/{usableStaff}
          </span>
          <span className={cn("inline-flex items-center gap-1 tabular", tone(freeVans, usableVans))}>
            <Truck className="size-3.5" strokeWidth={1.75} />
            {freeVans}/{usableVans}
          </span>
          <span className="ml-auto font-medium text-mist-400">free</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-2">
        {(["staff", "vehicles"] as const).map((group) => (
          <div key={group} className={group === "vehicles" ? "mt-2 border-t border-border pt-2" : ""}>
            <p className="eyebrow px-1 pb-1">{group}</p>
            {rows[group].length === 0 ? (
              <p className="px-1 pb-1 text-xs text-mist-400">None yet — add them in Staff & Fleet.</p>
            ) : (
              rows[group].map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 rounded px-1 py-1">
                  <span className="min-w-0 truncate text-xs text-foreground">{r.name}</span>
                  {r.state === "unavailable" ? (
                    <span className={cn("shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] font-medium", UNAVAIL_META.cls)}>
                      {r.unavailReason ?? UNAVAIL_META.label}
                    </span>
                  ) : (
                    <span className={cn("shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] font-medium", STATE_META[r.state].cls)}>
                      {r.state === "partial" ? `Busy ${r.windows.join(", ")}` : STATE_META[r.state].label}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function JobCard({
  appt,
  brand = null,
  multiDay,
  assigned,
  staff,
  vehicles,
  highlight,
  onDragOverChange,
  onDropResource,
  onAssign,
}: {
  appt: BoardAppt;
  /** Resolved chip data — null hides the chip (single-brand mode, or the
   *  ?brand= filter already names one brand; multi-brand PRD §4). */
  brand?: BrandChipData | null;
  multiDay: boolean;
  assigned: BoardAssignment[];
  staff: BoardStaff[];
  vehicles: BoardVehicle[];
  highlight: boolean;
  onDragOverChange: (on: boolean) => void;
  onDropResource: (res: Resource) => void;
  onAssign: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const isRemoval = appt.appt_type === "removal";
  const isPack = appt.appt_type === "pack";
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
  const assignedStaff = assigned.filter((a) => a.staff_id);
  const assignedVehicles = assigned.filter((a) => a.vehicle_id);

  function unassign(id: string, name: string) {
    start(async () => {
      const r = await unassignAction(id);
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(`${name} taken off.`);
        router.refresh();
      }
    });
  }

  const req = appt.required;
  // A pack is under-crewed with nobody on it; its vans requirement is 0, so a
  // van-less pack never reads "short" on vans.
  const under =
    (isRemoval || isPack) && req ? assignedVehicles.length < req.vans || assignedStaff.length < req.men : false;
  // Warn-only: a removal with a van assigned needs at least one driver on the crew.
  const assignedDrivers = assignedStaff.filter((a) => staffById.get(a.staff_id!)?.is_driver).length;
  const driverWarn = isRemoval && needsDriverWarning({ assignedVans: assignedVehicles.length, assignedDrivers });

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          onDragOverChange(true);
        }
      }}
      onDragLeave={() => onDragOverChange(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragOverChange(false);
        try {
          const res = JSON.parse(e.dataTransfer.getData(DND_MIME)) as Resource;
          if (res?.id && (res.kind === "staff" || res.kind === "vehicle")) onDropResource(res);
        } catch {
          /* not ours */
        }
      }}
      className={cn(
        "rounded-md border bg-card p-2.5 text-xs shadow-xs transition-colors",
        // Job identity by colour: moves carry the solid red rail, packs an amber
        // rail (crew-only, day-before), surveys sit on the teal family (dashed =
        // lighter commitment than a move).
        isRemoval
          ? "border-l-[3px] border-l-mm-red border-border"
          : isPack
            ? "border-l-[3px] border-l-warn border-border"
            : "border-dashed border-survey-border bg-survey-bg/40",
        highlight && "border-mm-red bg-mm-red-tint/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {appt.lead_id ? (
            <Link href={`/leads/${appt.lead_id}`} className="focus-ring block truncate text-[13px] font-semibold text-foreground hover:underline">
              {appt.lead_name ?? appt.title ?? "Job"}
            </Link>
          ) : (
            <p className="truncate text-[13px] font-semibold text-foreground">{appt.title ?? "Job"}</p>
          )}
          <p className="mt-0.5 flex items-center gap-1 text-mist-500">
            {multiDay ? <CalendarRange className="size-3 shrink-0 text-mist-400" strokeWidth={1.75} /> : null}
            {apptWindow(appt)}
            <span className="text-mist-300">·</span>
            <span
              className={cn(
                "font-semibold capitalize",
                isRemoval ? "text-mm-red-deep" : isPack ? "text-warn" : "text-survey-deep",
              )}
            >
              {isRemoval ? "Move" : isPack ? "Pack" : appt.appt_type}
            </span>
            {/* Brand chip beside the type label (multi-brand PRD §4 /schedule) —
                this board is where two brands' jobs visually collide. */}
            {brand ? <BrandChip brand={brand} size={16} /> : null}
          </p>
        </div>
        {appt.lead_status ? (
          <span
            className={cn(
              "shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] font-semibold",
              LEAD_STATUS_META[appt.lead_status as keyof typeof LEAD_STATUS_META]?.className ??
                "bg-muted text-mist-500",
            )}
          >
            {LEAD_STATUS_META[appt.lead_status as keyof typeof LEAD_STATUS_META]?.label ?? appt.lead_status}
          </span>
        ) : null}
      </div>

      {appt.from_postcode || appt.to_postcode ? (
        <p className="tabular mt-1 truncate text-[11px] text-mist-400">
          {appt.from_postcode ?? "?"} → {appt.to_postcode ?? "?"}
        </p>
      ) : null}

      {req ? (
        <p className={cn("tabular mt-1 text-[11px] font-semibold", under ? "text-danger" : "text-success")}>
          {isPack
            ? `Crew ${assignedStaff.length}/${req.men}${assignedVehicles.length ? ` · Van ${assignedVehicles.length}` : ""}`
            : `Vans ${assignedVehicles.length}/${req.vans} · Crew ${assignedStaff.length}/${req.men}`}
          {under ? " — short" : " ✓"}
        </p>
      ) : null}

      {appt.sigNeeded ? (
        <p className="mt-1 inline-flex items-center gap-1 rounded-pill border border-warn-border bg-warn-bg px-1.5 py-0.5 text-[10px] font-semibold text-warn">
          Signature needed on arrival
        </p>
      ) : null}

      {driverWarn ? (
        <p className="mt-1 inline-flex items-center gap-1 rounded-pill border border-warn-border bg-warn-bg px-1.5 py-0.5 text-[10px] font-semibold text-warn">
          <ShieldAlert className="size-3" strokeWidth={2} />
          No driver assigned
        </p>
      ) : null}

      {assigned.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {assignedStaff.map((a) => {
            const s = staffById.get(a.staff_id!);
            return (
              <AssignedChip
                key={a.id}
                icon={<UserRound className="size-3" strokeWidth={1.75} />}
                label={s?.full_name ?? "Staff"}
                driver={s?.is_driver}
                pending={pending}
                onRemove={() => unassign(a.id, s?.full_name ?? "Staff")}
              />
            );
          })}
          {assignedVehicles.map((a) => {
            const v = vehicleById.get(a.vehicle_id!);
            return (
              <AssignedChip
                key={a.id}
                icon={<Truck className="size-3" strokeWidth={1.75} />}
                label={v?.name ?? "Vehicle"}
                warn={v ? vehicleNeedsAttention(v) : false}
                pending={pending}
                onRemove={() => unassign(a.id, v?.name ?? "Vehicle")}
              />
            );
          })}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={onAssign}
          className="focus-ring w-full flex-1 rounded-md border border-input bg-card py-1 text-[11px] font-medium text-mist-500 transition-colors hover:bg-muted hover:text-foreground"
        >
          Assign staff / vehicle
        </button>
        {isRemoval ? (
          <JobSheetButton appointmentId={appt.id} fileHint={appt.lead_name ?? appt.title ?? "job"} variant="icon" />
        ) : null}
      </div>
    </div>
  );
}

function AssignedChip({
  icon,
  label,
  warn,
  driver,
  pending,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  warn?: boolean;
  driver?: boolean;
  pending: boolean;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill border border-border bg-muted/60 py-0.5 pl-1.5 pr-0.5 text-[11px] font-medium text-foreground">
      {icon}
      <span className="max-w-[110px] truncate">{label}</span>
      {driver ? <CarFront className="size-3 text-mist-500" strokeWidth={1.75} /> : null}
      {warn ? <ShieldAlert className="size-3 text-warn" strokeWidth={2} /> : null}
      <button
        type="button"
        onClick={onRemove}
        disabled={pending}
        aria-label={`Remove ${label}`}
        className="focus-ring flex size-4.5 items-center justify-center rounded-full text-mist-400 hover:bg-mist-100 hover:text-foreground disabled:opacity-50"
      >
        <X className="size-3" strokeWidth={2} />
      </button>
    </span>
  );
}

/** Modal assignment — the iPad path. Every row shows its availability against
 *  THIS job; clashes read amber but stay selectable (warn, don't block). */
function AssignDialog({
  appt,
  staff,
  vehicles,
  assignments,
  apptById,
  unavailByVehicle,
  availByStaff,
  clashLabels,
  onClose,
}: {
  appt: BoardAppt;
  staff: BoardStaff[];
  vehicles: BoardVehicle[];
  assignments: BoardAssignment[];
  apptById: Map<string, ApptLite>;
  unavailByVehicle: Map<string, UnavailabilityWindow[]>;
  availByStaff: Map<string, AvailabilityRow[]>;
  clashLabels: (clashes: ApptLite[]) => string[];
  onClose: () => void;
}) {
  // Every day the move spans — warn if the van is off-road on ANY of them,
  // not just the first (multi-day moves can straddle a garage window).
  const apptDaysList = apptDays(appt);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const current = assignments.filter((a) => a.appointment_id === appt.id);
  const [staffSel, setStaffSel] = useState<Set<string>>(
    () => new Set(current.filter((a) => a.staff_id).map((a) => a.staff_id!)),
  );
  const [vehicleSel, setVehicleSel] = useState<Set<string>>(
    () => new Set(current.filter((a) => a.vehicle_id).map((a) => a.vehicle_id!)),
  );

  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  async function save() {
    setBusy(true);
    // try/finally: a rejected action must clear busy — otherwise Confirm stays
    // disabled+spinning and the assignment is silently not saved (a job can go
    // out unassigned).
    try {
      const res = await setAssignmentsAction({
        appointment_id: appt.id,
        staff_ids: [...staffSel],
        vehicle_ids: [...vehicleSel],
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Assignments updated.");
      onClose();
      router.refresh();
    } catch {
      toast.error("Couldn't reach the server — check the job's crew/vans before retrying.");
    } finally {
      setBusy(false);
    }
  }

  const row = (
    id: string,
    name: string,
    sub: string,
    kind: "staff" | "vehicle",
    selected: boolean,
    onToggle: () => void,
    warn?: boolean,
    driver?: boolean,
  ) => {
    const clashes = clashesFor(id, kind, appt, assignments, apptById);
    return (
      <button
        key={id}
        type="button"
        onClick={onToggle}
        aria-pressed={selected}
        className={cn(
          "focus-ring flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
          selected ? "border-mm-red bg-mm-red-tint/40" : "border-border bg-card hover:bg-muted",
        )}
      >
        {kind === "staff" ? (
          <UserRound className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
        ) : (
          <Truck className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="truncate">{name}</span>
            {driver ? <CarFront className="size-3.5 shrink-0 text-foreground" strokeWidth={1.75} /> : null}
            {warn ? <ShieldAlert className="size-3.5 shrink-0 text-warn" strokeWidth={2} /> : null}
          </span>
          <span className="block truncate text-xs capitalize text-mist-400">{sub}</span>
          {clashes.length ? (
            <span className="mt-0.5 block truncate text-[11px] font-medium text-warn">
              Busy: {clashLabels(clashes).join("; ")}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
            selected ? "border-mm-red bg-mm-red text-white" : "border-input text-transparent",
          )}
        >
          ✓
        </span>
      </button>
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            Assign — {appt.lead_name ?? appt.title ?? "job"}
          </DialogTitle>
          <DialogDescription>
            {apptWindow(appt)}
            {appt.required ? ` · needs ${appt.required.vans} van${appt.required.vans === 1 ? "" : "s"} + ${appt.required.men} crew` : ""}
            . A busy warning never blocks — you decide.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div>
            <p className="eyebrow pb-2">Staff</p>
            <div className="space-y-1.5">
              {staff.length === 0 ? (
                <p className="text-xs text-mist-400">
                  No staff yet — add the crew in <Link href="/resources" className="underline">Staff &amp; Fleet</Link>.
                </p>
              ) : (
                staff.map((s) =>
                  row(
                    s.id,
                    s.full_name,
                    s.staff_role,
                    "staff",
                    staffSel.has(s.id),
                    () => toggle(staffSel, s.id, setStaffSel),
                    apptDaysList.some((day) => staffOffOn(availByStaff.get(s.id) ?? [], day, s.working_days ?? undefined).off),
                    s.is_driver,
                  ),
                )
              )}
            </div>
          </div>
          <div>
            <p className="eyebrow pb-2">Vehicles</p>
            <div className="space-y-1.5">
              {vehicles.length === 0 ? (
                <p className="text-xs text-mist-400">
                  No vehicles yet — add the fleet in{" "}
                  <Link href="/resources?tab=vehicles" className="underline">Staff &amp; Fleet</Link>.
                </p>
              ) : (
                vehicles.map((v) =>
                  row(
                    v.id,
                    v.name,
                    v.registration || v.vehicle_type,
                    "vehicle",
                    vehicleSel.has(v.id),
                    () => toggle(vehicleSel, v.id, setVehicleSel),
                    vehicleNeedsAttention(v) ||
                      apptDaysList.some((day) => vehicleOffRoad(v, unavailByVehicle.get(v.id) ?? [], day).offRoad),
                  ),
                )
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
