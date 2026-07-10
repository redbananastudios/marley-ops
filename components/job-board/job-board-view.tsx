"use client";

/**
 * Job Board — the week's jobs with per-day resource capacity and assignment
 * (iMVE clone-and-improve, docs/imve-discovery.md §1). Improvements over iMVE:
 * clash WARNING on assign (they double-book silently), vehicle compliance badge
 * on the chip, and required-vs-assigned crew derived from the accepted quote.
 * Assign works by modal (the iPad-reliable path) AND by dragging a resource
 * from the rail onto a job card (the desktop nicety).
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarRange,
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
import { LEAD_STATUS_META } from "@/components/lead-status-badge";
import {
  apptDays,
  apptWindow,
  clashesFor,
  resourceDayState,
  type ApptLite,
  type DayState,
} from "@/lib/job-board";
import { vehicleNeedsAttention } from "@/lib/vehicles";
import {
  assignResourceAction,
  setAssignmentsAction,
  unassignAction,
} from "@/app/(dashboard)/schedule/board/actions";

export interface BoardAppt extends ApptLite {
  title: string | null;
  appt_type: string;
  lead_id: string | null;
  lead_name: string | null;
  lead_status: string | null;
  from_postcode: string | null;
  to_postcode: string | null;
  required: { vans: number; men: number } | null;
}

export interface BoardStaff {
  id: string;
  full_name: string;
  staff_role: string;
}

export interface BoardVehicle {
  id: string;
  name: string;
  vehicle_type: string;
  registration: string;
  tax_due: string | null;
  mot_due: string | null;
  insurance_renewal: string | null;
}

export interface BoardAssignment {
  id: string;
  appointment_id: string;
  staff_id: string | null;
  vehicle_id: string | null;
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
  booked: { label: "Booked", cls: "bg-mm-red-tint text-mm-red-deep" },
};

export function JobBoardView({
  appts,
  staff,
  vehicles,
  assignments,
  thisWeekStart,
  today,
}: {
  appts: BoardAppt[];
  staff: BoardStaff[];
  vehicles: BoardVehicle[];
  assignments: BoardAssignment[];
  thisWeekStart: string;
  today: string;
}) {
  const router = useRouter();
  const [weekStart, setWeekStart] = useState(thisWeekStart);
  const [showSurveys, setShowSurveys] = useState(true);
  const [railOpen, setRailOpen] = useState(true);
  const [assignFor, setAssignFor] = useState<BoardAppt | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ appt: BoardAppt; res: Resource; clashLabels: string[] } | null>(
    null,
  );
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
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
  const daysByAppt = useMemo(() => new Map(appts.map((a) => [a.id, apptDays(a)])), [appts]);

  const cardsForDay = (day: string) =>
    appts
      .filter((a) => (showSurveys || a.appt_type !== "survey") && (daysByAppt.get(a.id) ?? []).includes(day))
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
    const r = await assignResourceAction(appt.id, { kind: res.kind, id: res.id });
    if (!r.ok) toast.error(r.error);
    else {
      toast.success("already" in r && r.already ? `${res.name} was already on this job.` : `${res.name} assigned.`);
      router.refresh();
    }
  }

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

        <button
          type="button"
          onClick={() => setShowSurveys((v) => !v)}
          aria-pressed={showSurveys}
          className={cn(
            "focus-ring min-h-9 rounded-md border border-input px-3 text-sm font-medium transition-colors",
            showSurveys ? "bg-mm-red-tint text-mm-red-deep" : "bg-card text-mist-500 hover:bg-muted",
          )}
        >
          Surveys
        </button>

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
                      icon={<UserRound className="size-3.5 text-mist-400" strokeWidth={1.75} />}
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
                      icon={<Truck className="size-3.5 text-mist-400" strokeWidth={1.75} />}
                      warn={vehicleNeedsAttention(v)}
                    />
                  ))
                )}
              </div>
              <p className="mt-4 border-t border-border pt-2 text-[11px] leading-snug text-mist-400">
                Drag onto a job, or use Assign on the card.
              </p>
            </div>
          </aside>
        ) : null}

        {/* week grid */}
        <div className="flex-1 overflow-x-auto pb-2">
          <div className="grid min-w-[1190px] grid-cols-7 gap-2">
            {days.map((day) => {
              const heading = dayHeading(day);
              const isToday = day === today;
              const cards = cardsForDay(day);
              return (
                <div key={day} className="flex min-h-[320px] flex-col rounded-lg border border-border bg-mist-50/50">
                  <div
                    className={cn(
                      "rounded-t-lg border-b border-border px-2.5 py-2",
                      isToday ? "bg-mm-red-tint" : "bg-card",
                    )}
                  >
                    <div className="flex items-baseline justify-between">
                      <p className={cn("text-sm font-semibold", isToday ? "text-mm-red-deep" : "text-foreground")}>
                        {heading.dow}
                      </p>
                      <p className="text-xs text-mist-400">{heading.date}</p>
                    </div>
                    <CapacityStrip
                      day={day}
                      staff={staff}
                      vehicles={vehicles}
                      assignments={assignments}
                      apptById={apptById}
                    />
                  </div>

                  <div className="flex flex-1 flex-col gap-2 p-2">
                    {cards.length === 0 ? (
                      <p className="py-6 text-center text-xs text-mist-300">—</p>
                    ) : (
                      cards.map((a) => (
                        <JobCard
                          key={`${a.id}:${day}`}
                          appt={a}
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
            })}
          </div>
        </div>
      </div>

      {assignFor ? (
        <AssignDialog
          appt={assignFor}
          staff={staff}
          vehicles={vehicles}
          assignments={assignments}
          apptById={apptById}
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
  icon,
  warn,
}: {
  res: Resource;
  sub: string;
  icon: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MIME, JSON.stringify(res));
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={`Drag ${res.name} onto a job`}
      className="flex cursor-grab items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 active:cursor-grabbing"
    >
      <GripVertical className="size-3.5 shrink-0 text-mist-300" strokeWidth={1.75} />
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{res.name}</span>
        <span className="block truncate text-[10px] capitalize text-mist-400">{sub}</span>
      </span>
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
}: {
  day: string;
  staff: BoardStaff[];
  vehicles: BoardVehicle[];
  assignments: BoardAssignment[];
  apptById: Map<string, ApptLite>;
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
    return {
      staff: staff.map((s) => ({ id: s.id, name: s.full_name, ...stateOf(s.id, "staff") })),
      vehicles: vehicles.map((v) => ({ id: v.id, name: v.name, ...stateOf(v.id, "vehicle") })),
    };
  }, [day, staff, vehicles, assignments, apptById]);

  const freeStaff = rows.staff.filter((r) => r.state === "free").length;
  const freeVans = rows.vehicles.filter((r) => r.state === "free").length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Who's free this day"
          className="focus-ring mt-1.5 flex w-full items-center gap-2 rounded-md bg-muted/70 px-2 py-1 text-[11px] font-medium text-mist-500 transition-colors hover:bg-muted"
        >
          <span className={cn("inline-flex items-center gap-1", freeStaff === 0 && staff.length > 0 && "text-mm-red-deep")}>
            <UsersRound className="size-3.5" strokeWidth={1.75} />
            {freeStaff}/{staff.length}
          </span>
          <span className={cn("inline-flex items-center gap-1", freeVans === 0 && vehicles.length > 0 && "text-mm-red-deep")}>
            <Truck className="size-3.5" strokeWidth={1.75} />
            {freeVans}/{vehicles.length}
          </span>
          <span className="ml-auto text-mist-400">free</span>
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
                  <span className={cn("shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] font-medium", STATE_META[r.state].cls)}>
                    {r.state === "partial" ? `Busy ${r.windows.join(", ")}` : STATE_META[r.state].label}
                  </span>
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
  const under = isRemoval && req ? assignedVehicles.length < req.vans || assignedStaff.length < req.men : false;

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
        isRemoval ? "border-l-[3px] border-l-mm-red border-border" : "border-dashed border-border",
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
            <span className="capitalize">{isRemoval ? "Move" : appt.appt_type}</span>
          </p>
        </div>
        {appt.lead_status ? (
          <span className="shrink-0 rounded-pill bg-muted px-1.5 py-0.5 text-[10px] font-medium text-mist-500">
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
        <p className={cn("mt-1 text-[11px] font-medium", under ? "text-mm-red-deep" : "text-mist-500")}>
          Vans {assignedVehicles.length}/{req.vans} · Crew {assignedStaff.length}/{req.men}
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

      <button
        type="button"
        onClick={onAssign}
        className="focus-ring mt-2 w-full rounded-md border border-input bg-card py-1 text-[11px] font-medium text-mist-500 transition-colors hover:bg-muted hover:text-foreground"
      >
        Assign staff / vehicle
      </button>
    </div>
  );
}

function AssignedChip({
  icon,
  label,
  warn,
  pending,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  warn?: boolean;
  pending: boolean;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill border border-border bg-muted/60 py-0.5 pl-1.5 pr-0.5 text-[11px] font-medium text-foreground">
      {icon}
      <span className="max-w-[110px] truncate">{label}</span>
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
  clashLabels,
  onClose,
}: {
  appt: BoardAppt;
  staff: BoardStaff[];
  vehicles: BoardVehicle[];
  assignments: BoardAssignment[];
  apptById: Map<string, ApptLite>;
  clashLabels: (clashes: ApptLite[]) => string[];
  onClose: () => void;
}) {
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
    const res = await setAssignmentsAction({
      appointment_id: appt.id,
      staff_ids: [...staffSel],
      vehicle_ids: [...vehicleSel],
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Assignments updated.");
    onClose();
    router.refresh();
  }

  const row = (
    id: string,
    name: string,
    sub: string,
    kind: "staff" | "vehicle",
    selected: boolean,
    onToggle: () => void,
    warn?: boolean,
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
                  row(s.id, s.full_name, s.staff_role, "staff", staffSel.has(s.id), () =>
                    toggle(staffSel, s.id, setStaffSel),
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
                    vehicleNeedsAttention(v),
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
