"use client";

/**
 * Schedule & Allocation — one page, two views of the same day (design doc
 * docs/schedule-allocation-design.md). ADDITIVE: the existing /schedule/removals
 * diary and /schedule/board Job Board are untouched.
 *
 *  - Availability (default) answers "can we sell this day?" — a Mon-first month
 *    grid graded by the confirmed removals' REQUIRED vans/crew vs the live fleet
 *    (lib/schedule/capacity), a soft-demand panel of deposit-paid leads not yet
 *    on the diary, and a day summary for the selected date.
 *  - Day Allocation reuses the Job Board for dispatch (surveys hidden).
 *
 * The selected day lives in the URL (?date=YYYY-MM-DD) so both tabs share it;
 * month browsing is local. All date maths is pure + UTC-safe (string dates).
 */

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, CalendarRange, ChevronLeft, ChevronRight, Plus, SquarePen, TriangleAlert, Truck, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { cleanApproxWindow, windowTierLabel, WINDOW_TIER_LABELS } from "@/lib/bookings/booking-details";
import { apptDays, apptWindow } from "@/lib/job-board";
import { dayCapacityState, sumRequired, usableFleetForDay, type CapacityState } from "@/lib/schedule/capacity";
import { buildWeekValues, type WeekValue } from "@/lib/schedule/week-value";
import { type AvailabilityRow } from "@/lib/staff/availability";
import { type UnavailabilityWindow } from "@/lib/fleet/availability";
import {
  BookingDetailsDialog,
  type BookingDetailsContext,
  type BookingDetailsInitial,
} from "@/components/bookings/booking-details-dialog";
import {
  AppointmentDialog,
  type EditTarget,
  type EstimatorOption,
  type LeadOption,
} from "@/components/schedule/appointment-dialog";
import { AppointmentViewDialog } from "@/components/schedule/appointment-view-dialog";
import { RescheduleDialog } from "@/components/schedule/reschedule-dialog";
import { ChangeDateDialog } from "@/components/bookings/change-date-dialog";
import type { SchedulerEvent } from "@/components/schedule/scheduler-view";
import {
  JobBoardView,
  type BoardAppt,
  type BoardAssignment,
  type BoardStaff,
  type BoardStaffAvailability,
  type BoardUnavailability,
  type BoardVehicle,
} from "@/components/job-board/job-board-view";

export interface AvailAppt {
  id: string;
  /** 'removal' | 'pack' — packs are crew-only day-before jobs that consume
   *  capacity but carry no money chips of their own. */
  appt_type: string;
  lead_id: string | null;
  lead_name: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean | null;
  from_postcode: string | null;
  to_postcode: string | null;
  requiredVans: number;
  requiredCrew: number;
  property_type: string | null; // 'homeowner' | 'rented' | null
  // The lead's move-window capture (booking_details) — prefills the shared drawer.
  approx_window: string | null;
  approx_month: string | null;
  provisional_date: string | null;
  deposit: boolean; // £100 paid
  commitment: boolean; // 25% paid
  /** A 25% commitment was actually invoiced for this job. False when the date was
   *  never confirmed or the deposit already covered it — in which case there is
   *  no 25% to be due, and showing the chip sends staff chasing nothing. */
  commitmentApplies: boolean;
  /** Imported iMVE booking — old-terms job, the 25% commitment never applies. */
  legacy: boolean;
  /** Agreed value of this job, for the month view's week rail. Null when the
   *  booking carries no priceable quote — the rail reports those separately
   *  rather than counting them as £0. Admin-only; null for everyone else. */
  value?: number | null;
  /** Still outstanding on the job (0 once the balance is settled). */
  toCollect?: number | null;
  // For the view/edit/reschedule dialogs (same payload the removals diary carries).
  title: string | null;
  status: string | null;
  location: string | null;
  estimator_id: string | null;
  /** Carried so the edit dialog seeds the real text instead of blank — a blank
   *  seed here silently wiped the notes on save (this is the busiest surface). */
  notes: string | null;
}

export interface SoftDemandItem {
  lead_id: string;
  name: string;
  approx_window: string | null;
  approx_month: string | null; // approx_month = ISO 1st-of-month or null
  provisional_date: string | null;
  property_type: string | null;
  requiredVans: number | null;
  requiredCrew: number | null;
  commitment: boolean; // 25% paid (deposit is true by construction on this list)
}

/* ── pure, UTC-safe date helpers (mirrors job-board-view's addDays) ────────── */

/** yyyy-mm-dd ± n days. */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing the given day (UTC-safe). */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const fmt = (iso: string, opts: Intl.DateTimeFormatOptions): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });

/** Start time for the compact calendar chip ("09:00", or "All day"). */
function startLabel(a: AvailAppt): string {
  if (a.all_day || !a.starts_at) return "All day";
  return new Date(a.starts_at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  });
}

/** 7 day columns + the week rail. One constant so the header row and every
 *  week row are guaranteed to line up. */
const GRID_COLS_WITH_RAIL = "grid-cols-[repeat(7,minmax(0,1fr))_104px]";

const money = (n: number): string =>
  "£" + Math.round(n).toLocaleString("en-GB");

/**
 * What this week of removals is worth, beside the week it describes. Headline
 * is the agreed value of the jobs booked in the row; "to collect" appears only
 * when something is still owed. A week with nothing booked stays blank rather
 * than reading "£0" — an empty diary is not a zero-pound week, and printing
 * £0 six times makes the rail noise instead of signal.
 */
function WeekRail({ week }: { week?: WeekValue }): React.JSX.Element {
  if (!week || week.jobCount === 0) {
    return <div className="min-h-[92px] rounded-md border border-dashed border-border/60 bg-muted/20" aria-hidden />;
  }
  // Hovering names the jobs behind the count. The grid can't be counted by eye
  // — a two-day move draws a chip on both days and a busy day hides the rest
  // behind "+N more" — so the rail carries its own working.
  const working = `${week.jobCount} ${week.jobCount === 1 ? "job" : "jobs"} this week:\n${week.customers
    .map((c) => `· ${c}`)
    .join("\n")}`;
  return (
    <div
      title={working}
      className="flex min-h-[92px] cursor-help flex-col justify-center gap-0.5 rounded-md border border-border bg-muted/40 p-2 text-right"
    >
      <p className="tabular font-display text-base font-bold leading-none text-foreground">
        {money(week.agreedTotal)}
      </p>
      <p className="text-[10px] font-semibold text-mist-500">
        {week.jobCount} {week.jobCount === 1 ? "job" : "jobs"}
      </p>
      {week.toCollect > 0 ? (
        <p className="tabular text-[10px] text-mist-400">{money(week.toCollect)} to collect</p>
      ) : null}
      {/* Says so rather than quietly under-reporting: an unpriced booking (a
          legacy import, or a diary block with no quote) is real work whose
          value is not in the figure above. */}
      {week.unpricedJobs > 0 ? (
        <p className="text-[10px] font-medium text-warn">
          {week.unpricedJobs} not priced
        </p>
      ) : null}
    </div>
  );
}

/* ── capacity-state presentation ──────────────────────────────────────────── */

const CAP_META: Record<
  CapacityState,
  { label: string; short: string; pill: string; text: string; swatch: string; cellBg: string }
> = {
  available: {
    label: "Available",
    short: "Avail",
    pill: "border-success-border bg-success-bg text-success",
    text: "text-success",
    swatch: "bg-success",
    cellBg: "bg-card",
  },
  limited: {
    label: "Limited",
    short: "Ltd",
    pill: "border-warn-border bg-warn-bg text-warn",
    text: "text-warn",
    swatch: "bg-warn",
    cellBg: "bg-warn-bg",
  },
  full: {
    label: "Full",
    short: "Full",
    pill: "border-danger-border bg-danger-bg text-danger",
    text: "text-danger",
    swatch: "bg-danger",
    cellBg: "bg-danger-bg",
  },
  over: {
    label: "Over",
    short: "Over",
    pill: "border-danger-border bg-danger-bg text-danger",
    text: "text-danger",
    swatch: "bg-danger",
    cellBg: "bg-danger-bg",
  },
};

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function StatePill({ state }: { state: CapacityState }): React.JSX.Element {
  const meta = CAP_META[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-pill border px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide",
        meta.pill,
      )}
    >
      {state === "over" ? <TriangleAlert className="size-2.5" strokeWidth={2} /> : null}
      {meta.label}
    </span>
  );
}

/** Homeowner date is fixed (can't move); rented flexes — the office reads the tag
 *  to know which day it can shuffle. */
function PropertyTag({ type }: { type: string | null }): React.JSX.Element | null {
  if (type === "homeowner")
    return (
      <span className="rounded-pill border border-danger-border bg-danger-bg px-2 py-0.5 text-[10px] font-semibold text-danger">
        Homeowner · fixed
      </span>
    );
  if (type === "rented")
    return (
      <span className="rounded-pill border border-success-border bg-success-bg px-2 py-0.5 text-[10px] font-semibold text-success">
        Rented · flexible
      </span>
    );
  return null;
}

function Estimate({ vans, crew }: { vans: number | null; crew: number | null }): React.JSX.Element | null {
  if (vans == null && crew == null) return null;
  return (
    <span className="tabular inline-flex items-center gap-2 text-[11px] text-mist-500">
      {vans != null ? (
        <span className="inline-flex items-center gap-0.5">
          <Truck className="size-3" strokeWidth={1.75} />
          {vans}
        </span>
      ) : null}
      {crew != null ? (
        <span className="inline-flex items-center gap-0.5">
          <UsersRound className="size-3" strokeWidth={1.75} />
          {crew}
        </span>
      ) : null}
    </span>
  );
}

export function ScheduleAllocationView(props: {
  availAppts: AvailAppt[];
  /** Show the month calendar's week-value rail (admin only). */
  showWeekValue?: boolean;
  softDemand: SoftDemandItem[];
  selectedDate: string; // YYYY-MM-DD
  today: string; // YYYY-MM-DD
  leads: LeadOption[];
  estimators: EstimatorOption[];
  defaultEstimatorId: string | null;
  baseLocation: string;
  events: SchedulerEvent[];
  board: {
    appts: BoardAppt[];
    staff: BoardStaff[];
    vehicles: BoardVehicle[];
    assignments: BoardAssignment[];
    unavailability: BoardUnavailability[];
    staffAvailability: BoardStaffAvailability[];
    thisWeekStart: string;
    today: string;
  };
}): React.JSX.Element {
  const { availAppts, showWeekValue = false, softDemand, selectedDate, today, leads, estimators, defaultEstimatorId, baseLocation, events, board } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ?tab=alloc deep-links straight into Day Allocation (the Bookings page's
  // "No crew allocated" chips land here); anything else = Availability.
  const [tab, setTab] = useState<"availability" | "alloc">(() =>
    searchParams.get("tab") === "alloc" ? "alloc" : "availability",
  );
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date(`${selectedDate}T00:00:00Z`);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
  });

  // Revenue column on/off. Lives in the URL like the tab above, so the choice
  // survives a refresh and the view stays linkable — ?revenue=0 hides it.
  const [showRevenue, setShowRevenue] = useState(() => searchParams.get("revenue") !== "0");
  const toggleRevenue = () => {
    const next = !showRevenue;
    setShowRevenue(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.delete("revenue");
    else params.set("revenue", "0");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Booking dialogs — the SAME create/view/edit/reschedule stack as the removals
  // diary, so this page is a full workstation, not a read-only dashboard. Booked
  // removals with a lead reschedule through the Payments Policy v2 ChangeDateDialog.
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewTarget, setViewTarget] = useState<EditTarget | null>(null);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reschedTarget, setReschedTarget] = useState<EditTarget | null>(null);
  // Shared booking-details drawer (move window / property) — one instance,
  // retargeted from the soft-demand panel and the day summary.
  const [bdOpen, setBdOpen] = useState(false);
  const [bdTarget, setBdTarget] = useState<{
    leadId: string;
    leadName: string;
    initial: BookingDetailsInitial;
    context: BookingDetailsContext;
  } | null>(null);
  const estimatorById = useMemo(() => new Map(estimators.map((e) => [e.id, e.full_name])), [estimators]);

  function openSoftDetails(item: SoftDemandItem) {
    setBdTarget({
      leadId: item.lead_id,
      leadName: item.name,
      initial: {
        approxWindow: item.approx_window,
        approxMonth: item.approx_month,
        provisionalDate: item.provisional_date,
        propertyType: item.property_type,
      },
      context: {
        requiredVans: item.requiredVans,
        requiredCrew: item.requiredCrew,
        // Soft demand = deposit-paid by construction (that's what earns the list).
        depositPaid: true,
        commitmentPaid: item.commitment,
      },
    });
    setBdOpen(true);
  }

  function openBookedDetails(a: AvailAppt) {
    if (!a.lead_id) return;
    setBdTarget({
      leadId: a.lead_id,
      leadName: a.lead_name ?? "Move",
      initial: {
        approxWindow: a.approx_window,
        approxMonth: a.approx_month,
        provisionalDate: a.provisional_date,
        propertyType: a.property_type,
      },
      context: {
        requiredVans: a.requiredVans,
        requiredCrew: a.requiredCrew,
        depositPaid: a.deposit,
        commitmentPaid: a.commitment,
      },
    });
    setBdOpen(true);
  }

  function toEditTarget(a: AvailAppt): EditTarget {
    // A removal's edit form manages its packing day too — find the lead's
    // scheduled pack (if any) in the full event set so the checkbox seeds true.
    const pack =
      a.appt_type === "removal" && a.lead_id
        ? events.find(
            (e) =>
              (e as { lead_id?: string | null }).lead_id === a.lead_id &&
              (e as { appt_type?: string }).appt_type === "pack" &&
              (e as { status?: string | null }).status === "scheduled",
          )
        : undefined;
    const packDate = pack?.starts_at
      ? new Date(pack.starts_at).toLocaleDateString("en-CA", { timeZone: "Europe/London" })
      : null;
    return {
      id: a.id,
      apptType: (a.appt_type === "pack" ? "pack" : "removal") as EditTarget["apptType"],
      leadId: a.lead_id,
      estimatorId: a.estimator_id,
      status: a.status,
      title: a.title,
      location: a.location,
      notes: a.notes ?? null,
      startsAt: a.starts_at,
      endsAt: a.ends_at ?? a.starts_at,
      packDate,
    };
  }

  function openView(a: AvailAppt) {
    setViewTarget(toEditTarget(a));
    setViewOpen(true);
  }

  // The selected day is the single source of truth in the URL — both tabs read it.
  function selectDate(date: string) {
    const next = new URLSearchParams(searchParams);
    next.set("date", date);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  function shiftMonth(delta: number) {
    setMonthCursor((c) => {
      const d = new Date(Date.UTC(c.year, c.month + delta, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });
  }

  function goToday() {
    const d = new Date(`${today}T00:00:00Z`);
    setMonthCursor({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
    selectDate(today);
  }

  // Every confirmed removal indexed by the UK days it spans.
  const apptsByDay = useMemo(() => {
    const m = new Map<string, AvailAppt[]>();
    for (const a of availAppts) {
      for (const d of apptDays(a)) {
        const list = m.get(d) ?? [];
        list.push(a);
        m.set(d, list);
      }
    }
    return m;
  }, [availAppts]);

  // Per-day availability lookups, built from the SAME board data the Job Board uses —
  // so the Availability calendar and Day Allocation grade a day against the identical
  // "who's actually working / which vans are on the road" picture.
  const availByStaff = useMemo(() => {
    const m = new Map<string, AvailabilityRow[]>();
    for (const a of board.staffAvailability) {
      const list = m.get(a.staff_id) ?? [];
      list.push({ date: a.date, status: a.status as "available" | "unavailable", note: a.note });
      m.set(a.staff_id, list);
    }
    return m;
  }, [board.staffAvailability]);
  const unavailByVehicle = useMemo(() => {
    const m = new Map<string, UnavailabilityWindow[]>();
    for (const u of board.unavailability) {
      const list = m.get(u.vehicle_id) ?? [];
      list.push({ start_date: u.start_date, end_date: u.end_date, reason: u.reason });
      m.set(u.vehicle_id, list);
    }
    return m;
  }, [board.unavailability]);

  // The fleet genuinely usable on a given day (crew off / vans off-road excluded),
  // NOT a constant all-time headcount — a weekend nobody works reads 0 crew, matching
  // the Job Board's 0/0 instead of the calendar falsely showing full crew.
  const fleetForDay = (iso: string) =>
    usableFleetForDay({ day: iso, staff: board.staff, vehicles: board.vehicles, availByStaff, unavailByVehicle });

  // Grade a day for sellability — worst of vans/crew wins (see lib/schedule/capacity).
  const gradeOf = (iso: string) => dayCapacityState({ ...sumRequired(apptsByDay.get(iso) ?? []), fleet: fleetForDay(iso) });

  // 42-cell Mon-first grid for the cursor month.
  const cells = useMemo(() => {
    const first = new Date(Date.UTC(monthCursor.year, monthCursor.month, 1));
    first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
    const start = first.toISOString().slice(0, 10);
    return Array.from({ length: 42 }, (_, i) => {
      const iso = addDays(start, i);
      const d = new Date(`${iso}T00:00:00Z`);
      return { iso, day: d.getUTCDate(), inMonth: d.getUTCMonth() === monthCursor.month };
    });
  }, [monthCursor]);

  // The six Mon–Sun rows the grid draws, and what each is worth. Weeks come
  // from the drawn cells (not the month), so the rail always describes the row
  // beside it — including its leading/trailing days from the next month along.
  const weekRows = useMemo(() => {
    const starts: string[] = [];
    for (let w = 0; w < 6; w++) starts.push(cells[w * 7].iso);
    return starts;
  }, [cells]);
  const weekValues = useMemo(() => {
    if (!showWeekValue || !showRevenue) return null;
    return buildWeekValues(
      availAppts.map((a) => ({
        id: a.id,
        leadId: a.lead_id,
        apptType: a.appt_type,
        startDay: apptDays(a)[0] ?? "",
        value: a.value ?? null,
        toCollect: a.toCollect ?? null,
        customer: a.lead_name,
      })),
      weekRows,
    );
  }, [showWeekValue, showRevenue, availAppts, weekRows]);

  // Soft demand grouped by month + window tier ("Beginning of September" /
  // "Middle of September" / bare "September"; else provisional_date's month;
  // else "No date yet"). Tier order inside a month: Beginning → Middle → End
  // → month-only, so the panel reads chronologically top to bottom.
  const softGroups = useMemo(() => {
    const tierRank: Record<string, number> = { early: 0, mid: 1, late: 2 };
    const groups = new Map<string, { label: string; sort: number; items: SoftDemandItem[] }>();
    for (const item of softDemand) {
      const rep = item.approx_month ?? item.provisional_date;
      let key: string;
      let label: string;
      let sort: number;
      if (rep) {
        const d = new Date(`${rep}T00:00:00Z`);
        const tier = item.approx_month ? cleanApproxWindow(item.approx_window) : null;
        const monthLabel = d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
        key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${tier ?? "month"}`;
        label = tier ? `${WINDOW_TIER_LABELS[tier]} of ${monthLabel}` : monthLabel;
        sort = (d.getUTCFullYear() * 12 + d.getUTCMonth()) * 10 + (tier ? tierRank[tier] : 3);
      } else {
        key = "no-date";
        label = "No date yet";
        sort = Number.MAX_SAFE_INTEGER;
      }
      const g = groups.get(key) ?? { label, sort, items: [] };
      g.items.push(item);
      groups.set(key, g);
    }
    const out = [...groups.values()].sort((a, b) => a.sort - b.sort);
    for (const g of out)
      g.items.sort(
        (x, y) =>
          (x.provisional_date ?? "9999").localeCompare(y.provisional_date ?? "9999") || x.name.localeCompare(y.name),
      );
    return out;
  }, [softDemand]);

  // Soft demand whose firm/approx date falls in the SAME week or month as the selected day.
  const nearSoft = useMemo(() => {
    const ws = mondayOf(selectedDate);
    const we = addDays(ws, 6);
    const sd = new Date(`${selectedDate}T00:00:00Z`);
    const sy = sd.getUTCFullYear();
    const sm = sd.getUTCMonth();
    return softDemand.filter((item) => {
      if (item.provisional_date && item.provisional_date >= ws && item.provisional_date <= we) return true;
      const rep = item.provisional_date ?? item.approx_month;
      if (rep) {
        const rd = new Date(`${rep}T00:00:00Z`);
        if (rd.getUTCFullYear() === sy && rd.getUTCMonth() === sm) return true;
      }
      return false;
    });
  }, [softDemand, selectedDate]);

  const selFleet = fleetForDay(selectedDate);
  const sel = gradeOf(selectedDate);
  const dayJobs = useMemo(
    () =>
      [...(apptsByDay.get(selectedDate) ?? [])].sort(
        (a, b) => Number(b.all_day) - Number(a.all_day) || (a.starts_at ?? "").localeCompare(b.starts_at ?? ""),
      ),
    [apptsByDay, selectedDate],
  );

  const metricTone = (free: number) => (free < 0 ? "text-danger" : free <= 1 ? "text-warn" : "text-foreground");

  return (
    <div className="flex flex-1 flex-col">
      {/* tabs */}
      <div
        role="tablist"
        aria-label="Schedule views"
        className="mb-4 inline-flex w-fit gap-1 rounded-lg border border-border bg-card p-1 shadow-xs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "availability"}
          onClick={() => setTab("availability")}
          className={cn(
            "focus-ring inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors",
            tab === "availability" ? "bg-foreground text-card" : "text-mist-500 hover:text-foreground",
          )}
        >
          Availability
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "alloc"}
          onClick={() => setTab("alloc")}
          className={cn(
            "focus-ring inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors",
            tab === "alloc" ? "bg-foreground text-card" : "text-mist-500 hover:text-foreground",
          )}
        >
          Day Allocation
          <span
            className={cn(
              "tabular rounded-pill px-2 py-0.5 text-[11px] font-semibold leading-none",
              tab === "alloc" ? "bg-mm-red text-white" : "bg-mm-red-tint text-mm-red-deep",
            )}
          >
            {fmt(selectedDate, { weekday: "short", day: "numeric" })}
          </span>
        </button>
      </div>

      {/* ============ AVAILABILITY ============ */}
      <div className={cn(tab !== "availability" && "hidden")}>
        {/* toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="inline-flex items-stretch overflow-hidden rounded-md border border-input bg-card">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              className="focus-ring flex min-h-9 w-9 items-center justify-center text-mist-400 transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="size-4" strokeWidth={1.75} />
            </button>
            <span className="tabular flex min-w-[150px] items-center justify-center border-x border-input px-3 text-sm font-medium text-foreground">
              {fmt(`${monthCursor.year}-${String(monthCursor.month + 1).padStart(2, "0")}-01`, {
                month: "long",
                year: "numeric",
              })}
            </span>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              className="focus-ring flex min-h-9 w-9 items-center justify-center text-mist-400 transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronRight className="size-4" strokeWidth={1.75} />
            </button>
          </div>
          <button
            type="button"
            onClick={goToday}
            className="focus-ring min-h-9 rounded-md border border-input bg-card px-3 text-sm font-medium text-mist-500 transition-colors hover:bg-muted hover:text-foreground"
          >
            Today
          </button>
          {/* Admins only — nobody else ever gets the column, so nobody else
              needs the switch. */}
          {showWeekValue ? (
            <button
              type="button"
              onClick={toggleRevenue}
              aria-pressed={showRevenue}
              className={cn(
                "focus-ring inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors",
                showRevenue
                  ? "border-mm-red/40 bg-mm-red-tint text-mm-red-deep"
                  : "border-input bg-card text-mist-500 hover:bg-muted hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-4 w-7 shrink-0 items-center rounded-pill p-0.5 transition-colors",
                  showRevenue ? "bg-mm-red" : "bg-mist-300",
                )}
                aria-hidden
              >
                <span
                  className={cn(
                    "size-3 rounded-pill bg-white transition-transform",
                    showRevenue ? "translate-x-3" : "translate-x-0",
                  )}
                />
              </span>
              Show revenue
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setEditTarget(null);
              setCreateOpen(true);
            }}
            className="focus-ring ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-4 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-mm-red-deep"
          >
            <Plus className="size-4" strokeWidth={2} />
            New booking · {fmt(selectedDate, { weekday: "short", day: "numeric", month: "short" })}
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* calendar + legend */}
          <div className="flex min-w-0 flex-col gap-4">
            <div className="rounded-lg border border-border bg-card p-2.5">
              <div className="overflow-x-auto">
                <div className={weekValues ? "min-w-[672px]" : "min-w-[560px]"}>
                  <div className={cn("mb-1.5 grid gap-1.5", weekValues ? GRID_COLS_WITH_RAIL : "grid-cols-7")}>
                    {DOW.map((d) => (
                      <div key={d} className="text-center text-[10px] font-bold uppercase tracking-wide text-mist-400">
                        {d}
                      </div>
                    ))}
                    {weekValues ? (
                      <div className="text-center text-[10px] font-bold uppercase tracking-wide text-mist-400">
                        Week
                      </div>
                    ) : null}
                  </div>
                  {/* One grid PER WEEK so each row can carry a trailing rail —
                      the 42 cells used to be a single 7-column grid where a
                      "week" was only an implicit CSS wrap with no element to
                      hang anything off. */}
                  <div className="flex flex-col gap-1.5">
                    {weekRows.map((weekStart, w) => (
                      <div key={weekStart} className={cn("grid gap-1.5", weekValues ? GRID_COLS_WITH_RAIL : "grid-cols-7")}>
                        {cells.slice(w * 7, w * 7 + 7).map((cell) => {
                      if (!cell.inMonth)
                        return (
                          <div
                            key={cell.iso}
                            className="min-h-[92px] rounded-md border border-transparent bg-muted/40 p-1.5 opacity-50"
                          >
                            <span className="text-xs font-semibold text-mist-400">{cell.day}</span>
                          </div>
                        );
                      const grade = gradeOf(cell.iso);
                      const meta = CAP_META[grade.state];
                      const jobs = apptsByDay.get(cell.iso) ?? [];
                      const isToday = cell.iso === today;
                      const isSelected = cell.iso === selectedDate;
                      return (
                        <button
                          type="button"
                          key={cell.iso}
                          onClick={() => selectDate(cell.iso)}
                          aria-pressed={isSelected}
                          className={cn(
                            "focus-ring relative flex min-h-[92px] flex-col gap-1 rounded-md border p-1.5 text-left transition-colors",
                            meta.cellBg,
                            isSelected
                              ? "border-mm-red ring-2 ring-inset ring-mm-red"
                              : isToday
                                ? "border-mm-red/60 ring-1 ring-inset ring-mm-red/60"
                                : "border-border hover:border-mist-400",
                          )}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span
                              className={cn(
                                "text-xs font-semibold",
                                isSelected || isToday ? "text-mm-red" : "text-mist-500",
                              )}
                            >
                              {cell.day}
                            </span>
                            <StatePill state={grade.state} />
                          </div>

                          {/* EVERY job on the day is drawn — the cell grows and,
                              because the week is one grid row, its siblings grow
                              with it. A day used to show two and collapse the
                              rest into "+N more", which hid real work on exactly
                              the days that needed looking at hardest. */}
                          {jobs.map((j) => {
                            // A move spanning several days draws a chip on each
                            // of them. Without saying so, one job reads as two
                            // and the week's count looks wrong.
                            const days = apptDays(j);
                            const dayIndex = days.indexOf(cell.iso);
                            const continuation = days.length > 1 && dayIndex > 0;
                            return (
                              <div
                                key={j.id}
                                title={continuation ? `${j.lead_name ?? "Move"} — day ${dayIndex + 1} of ${days.length}` : undefined}
                                className={cn(
                                  "flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold",
                                  j.appt_type === "pack"
                                    ? "bg-warn-bg text-warn ring-1 ring-inset ring-warn-border"
                                    : continuation
                                      ? "bg-foreground/70 text-card"
                                      : "bg-foreground text-card",
                                )}
                              >
                                <span className="tabular shrink-0 opacity-70">
                                  {continuation ? `day ${dayIndex + 1}` : startLabel(j)}
                                </span>
                                <span className="truncate">
                                  {j.appt_type === "pack" ? `Pack · ${j.lead_name ?? "job"}` : (j.lead_name ?? "Move")}
                                </span>
                              </div>
                            );
                          })}
                          <div className="tabular mt-auto flex items-center gap-2 pt-0.5 text-[10px] font-semibold">
                            <span
                              className={cn(
                                "inline-flex items-center gap-0.5",
                                grade.freeVans < 0 ? "text-danger" : "text-mist-500",
                              )}
                            >
                              <Truck className="size-3" strokeWidth={1.75} />
                              {grade.freeVans}
                            </span>
                            <span
                              className={cn(
                                "inline-flex items-center gap-0.5",
                                grade.freeCrew < 0 ? "text-danger" : "text-mist-500",
                              )}
                            >
                              <UsersRound className="size-3" strokeWidth={1.75} />
                              {grade.freeCrew}
                            </span>
                          </div>
                        </button>
                      );
                        })}
                        {weekValues ? <WeekRail week={weekValues.get(weekStart)} /> : null}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* legend */}
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="mb-3 text-sm font-semibold text-foreground">
                How a day is graded — capacity is a shared pool, worst of vans or crew wins
              </h3>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {(["available", "limited", "full", "over"] as const).map((state) => {
                  const meta = CAP_META[state];
                  const desc: Record<CapacityState, string> = {
                    available: "Spare van and crew.",
                    limited: "Down to the last of either.",
                    full: "None spare.",
                    over: "Booked needs exceed the fleet.",
                  };
                  return (
                    <div key={state} className="flex items-start gap-2.5">
                      <span className={cn("mt-0.5 size-3 shrink-0 rounded-[4px]", meta.swatch)} />
                      <div>
                        <p className={cn("flex items-center gap-1 text-xs font-bold", meta.text)}>
                          {state === "over" ? <TriangleAlert className="size-3" strokeWidth={2} /> : null}
                          {meta.label}
                        </p>
                        <p className="text-[11px] text-mist-400">{desc[state]}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* side: day summary + soft demand */}
          <div className="flex flex-col gap-4">
            {/* day summary */}
            <div className="rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <span className="text-sm font-semibold text-foreground">
                  {fmt(selectedDate, { weekday: "long", day: "numeric", month: "long" })}
                </span>
                <StatePill state={sel.state} />
              </div>
              <div className="flex flex-col gap-4 p-4">
                {/* free-capacity metrics */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-border bg-muted/40 p-2.5">
                    <p className="eyebrow flex items-center gap-1">
                      <Truck className="size-3" strokeWidth={1.75} />
                      Vans free
                    </p>
                    <p className={cn("tabular mt-0.5 text-lg font-bold", metricTone(sel.freeVans))}>
                      {sel.freeVans}
                      <span className="text-xs font-medium text-mist-400"> / {selFleet.vans}</span>
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-muted/40 p-2.5">
                    <p className="eyebrow flex items-center gap-1">
                      <UsersRound className="size-3" strokeWidth={1.75} />
                      Crew free
                    </p>
                    <p className={cn("tabular mt-0.5 text-lg font-bold", metricTone(sel.freeCrew))}>
                      {sel.freeCrew}
                      <span className="text-xs font-medium text-mist-400"> / {selFleet.crew}</span>
                    </p>
                  </div>
                </div>

                {/* booked removals */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="eyebrow">Booked in ({dayJobs.length})</h4>
                    <button
                      type="button"
                      onClick={() => {
                        setEditTarget(null);
                        setCreateOpen(true);
                      }}
                      className="focus-ring inline-flex items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-[11px] font-semibold text-mist-500 transition-colors hover:border-mm-red hover:text-mm-red"
                    >
                      <Plus className="size-3" strokeWidth={2} />
                      Book this day
                    </button>
                  </div>
                  {dayJobs.length === 0 ? (
                    <p className="text-xs text-mist-400">Nothing booked yet. The day is clear.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {dayJobs.map((j) => {
                        const multiDay = apptDays(j).length > 1;
                        // The row itself is a <button> (opens the view modal), so the
                        // move-window control renders BESIDE it, never nested inside.
                        return (
                          <div key={j.id} className="flex items-stretch gap-1.5">
                          <button
                            type="button"
                            onClick={() => openView(j)}
                            title="Open this booking"
                            className="focus-ring min-w-0 flex-1 rounded-md border border-border bg-card p-2.5 text-left transition-colors hover:border-mm-red/60"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-foreground">
                                {multiDay ? (
                                  <CalendarRange className="size-3 shrink-0 text-mist-400" strokeWidth={1.75} />
                                ) : null}
                                <span className="truncate">{j.lead_name ?? "Move"}</span>
                              </span>
                              <span className="tabular shrink-0 text-[11px] text-mist-400">{apptWindow(j)}</span>
                            </div>
                            {j.from_postcode || j.to_postcode ? (
                              <p className="tabular mt-1 truncate text-[11px] text-mist-400">
                                {j.from_postcode ?? "?"} → {j.to_postcode ?? "?"}
                              </p>
                            ) : null}
                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                              {j.appt_type === "pack" ? (
                                <>
                                  <span className="rounded-pill border border-warn-border bg-warn-bg px-2 py-0.5 text-[10px] font-semibold text-warn">
                                    Packing · crew only
                                  </span>
                                  <Estimate vans={null} crew={j.requiredCrew} />
                                </>
                              ) : (
                                <>
                                  <Estimate vans={j.requiredVans} crew={j.requiredCrew} />
                                  <PropertyTag type={j.property_type} />
                                  {j.legacy ? (
                                    // Old-terms iMVE job — no 25% ever applies, so a
                                    // "25% due" chip would send someone chasing it.
                                    <span
                                      className="rounded-pill border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-mist-500"
                                      title="Imported from iMVE — old-terms booking, payments handled manually"
                                    >
                                      Legacy (iMVE)
                                    </span>
                                  ) : j.commitmentApplies ? (
                                    <span
                                      className={cn(
                                        "rounded-pill border px-2 py-0.5 text-[10px] font-semibold",
                                        j.commitment
                                          ? "border-success-border bg-success-bg text-success"
                                          : "border-border bg-muted text-mist-500",
                                      )}
                                    >
                                      {j.commitment ? "25% ✓" : "25% due"}
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </div>
                          </button>
                          {j.lead_id && j.appt_type !== "pack" ? (
                            <button
                              type="button"
                              onClick={() => openBookedDetails(j)}
                              title="Move window and property"
                              aria-label={`Move window for ${j.lead_name ?? "this move"}`}
                              className="focus-ring flex w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-mist-400 transition-colors hover:border-mm-red/60 hover:text-mm-red"
                            >
                              <CalendarClock className="size-3.5" strokeWidth={1.75} />
                            </button>
                          ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* provisional interest around this date */}
                <div>
                  <h4 className="eyebrow mb-2">Provisional around this date</h4>
                  {nearSoft.length === 0 ? (
                    <p className="text-xs text-mist-400">No provisional interest near this day.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {nearSoft.map((item) => (
                        <div
                          key={item.lead_id}
                          className="flex items-center justify-between gap-2 rounded-md border border-warn-border bg-warn-bg px-2.5 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-warn">{item.name}</p>
                            <p className="mt-0.5 text-[10px] text-warn/80">
                              {item.provisional_date
                                ? `prov · ${fmt(item.provisional_date, { day: "numeric", month: "short" })}`
                                : (windowTierLabel(item.approx_window, item.approx_month) ?? "this month")}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-md border border-warn-border bg-card px-2 py-1 text-[10px] font-semibold text-warn">
                            Ring to reserve
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ±3-day neighbour strip */}
                <div>
                  <h4 className="eyebrow mb-2">Days either side</h4>
                  <div className="grid grid-cols-7 gap-1">
                    {Array.from({ length: 7 }, (_, i) => addDays(selectedDate, i - 3)).map((iso) => {
                      const grade = gradeOf(iso);
                      const meta = CAP_META[grade.state];
                      const isSel = iso === selectedDate;
                      return (
                        <button
                          type="button"
                          key={iso}
                          onClick={() => selectDate(iso)}
                          className={cn(
                            "focus-ring rounded-md border border-border px-1 py-1.5 text-center transition-colors hover:border-mist-400",
                            isSel && "ring-1 ring-inset ring-mm-red",
                          )}
                        >
                          <div className={cn("text-[11px] font-bold", meta.text)}>{fmt(iso, { day: "numeric" })}</div>
                          <div className={cn("mt-0.5 text-[8px] font-bold uppercase tracking-wide", meta.text)}>
                            {meta.short}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* soft demand ("thinking about it") */}
            <div className="rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between gap-2 px-4 pt-3">
                <h3 className="text-sm font-semibold text-foreground">Thinking about it</h3>
                <span className="tabular rounded-pill border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold text-mist-500">
                  {softDemand.length} · £100 down
                </span>
              </div>
              <p className="px-4 pt-1 text-[11px] text-mist-400">
                £100 secures Marley, not a date. Off the diary until the 25% earns the day.
              </p>
              <div className="flex flex-col gap-3 p-3">
                {softDemand.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-mist-400">No soft demand yet.</p>
                ) : (
                  softGroups.map((group) => (
                    <div key={group.label}>
                      <p className="eyebrow px-0.5 pb-1.5">{group.label}</p>
                      <div className="flex flex-col gap-2">
                        {group.items.map((item) => (
                          <div key={item.lead_id} className="rounded-md border border-border bg-muted/40 p-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[13px] font-semibold text-foreground">{item.name}</span>
                              <span className="flex shrink-0 items-center gap-1.5">
                              {item.provisional_date ? (
                                <span className="shrink-0 rounded-pill border border-warn-border bg-warn-bg px-2 py-0.5 text-[10px] font-semibold text-warn">
                                  prov · {fmt(item.provisional_date, { day: "numeric", month: "short" })}
                                </span>
                              ) : !item.approx_month && cleanApproxWindow(item.approx_window) ? (
                                // Tier without a month lands in "No date yet" — the chip is
                                // the only place the tier shows. With a month, the group
                                // header already says it.
                                <span className="shrink-0 rounded-pill border border-border bg-card px-2 py-0.5 text-[10px] font-medium text-mist-500">
                                  {windowTierLabel(item.approx_window)}
                                </span>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => openSoftDetails(item)}
                                title="Move window and property"
                                aria-label={`Move window for ${item.name}`}
                                className="focus-ring flex size-6 items-center justify-center rounded-md border border-border bg-card text-mist-400 transition-colors hover:border-mm-red/60 hover:text-mm-red"
                              >
                                <SquarePen className="size-3" strokeWidth={1.75} />
                              </button>
                              </span>
                            </div>
                            <div className="mt-1.5 flex items-center justify-between gap-2">
                              <Estimate vans={item.requiredVans} crew={item.requiredCrew} />
                              <PropertyTag type={item.property_type} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ============ DAY ALLOCATION ============ */}
      {tab === "alloc" ? (
        <div className="flex flex-1 flex-col">
          <JobBoardView {...board} initialWeekStart={mondayOf(selectedDate)} hideSurveys />
        </div>
      ) : null}

      {/* Booking dialogs — the same stack as the removals diary. Clicking a booked
          job opens the read-only view first; edit is a deliberate second step. */}
      <AppointmentViewDialog
        open={viewOpen}
        onOpenChange={setViewOpen}
        target={viewTarget}
        lead={viewTarget?.leadId ? (leads.find((l) => l.id === viewTarget.leadId) ?? null) : null}
        estimatorName={viewTarget?.estimatorId ? (estimatorById.get(viewTarget.estimatorId) ?? null) : null}
        baseLocation={baseLocation}
        onEdit={() => {
          setViewOpen(false);
          setEditTarget(viewTarget);
          setCreateOpen(true);
        }}
        onReschedule={() => {
          setViewOpen(false);
          setReschedTarget(viewTarget);
          setReschedOpen(true);
        }}
      />

      {/* Booked removals (with a lead) reschedule through the Payments Policy v2
          dialog — the single date-change path. Lead-less diary entries keep the
          plain reschedule. */}
      {reschedTarget && reschedTarget.apptType === "removal" && reschedTarget.leadId ? (
        <ChangeDateDialog
          appointmentId={reschedTarget.id}
          leadId={reschedTarget.leadId}
          startsAt={reschedTarget.startsAt}
          endsAt={reschedTarget.endsAt}
          presetStartsAt={null}
          presetEndsAt={null}
          open={reschedOpen}
          onOpenChange={setReschedOpen}
        />
      ) : (
        <RescheduleDialog
          open={reschedOpen}
          onOpenChange={setReschedOpen}
          target={reschedTarget}
          estimatorName={reschedTarget?.estimatorId ? (estimatorById.get(reschedTarget.estimatorId) ?? null) : null}
          events={events}
          presetDate={null}
        />
      )}

      {/* Shared booking-details drawer — the single writer for a lead's move
          window (approx window / target month / provisional date / property).
          Money renders read-only inside; it is never edited here. */}
      {bdTarget ? (
        <BookingDetailsDialog
          leadId={bdTarget.leadId}
          leadName={bdTarget.leadName}
          initial={bdTarget.initial}
          context={bdTarget.context}
          open={bdOpen}
          onOpenChange={setBdOpen}
        />
      ) : null}

      <AppointmentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        leads={leads}
        estimators={estimators}
        defaultEstimatorId={defaultEstimatorId}
        defaultType="removal"
        presetStart={editTarget ? undefined : `${selectedDate}T09:00`}
        edit={editTarget}
      />
    </div>
  );
}
