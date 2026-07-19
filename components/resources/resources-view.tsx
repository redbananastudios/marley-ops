"use client";

/**
 * Staff & Fleet — the assignable resources behind the coming Job Board v2
 * (iMVE clone-and-improve; see docs/imve-discovery.md). Two tabs:
 *  - Staff: crew records (movers/drivers/estimators) — not necessarily logins.
 *  - Vehicles: fleet with tax/MOT/insurance compliance chips iMVE never surfaces
 *    (amber = due within 30 days, red = overdue).
 * Archive (never delete) keeps history safe once assignments reference these.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  Loader2,
  Pencil,
  Phone,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Truck,
  UserRound,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { segmentedCountClass, segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteStaffAvailabilityAction,
  deleteVehicleUnavailabilityAction,
  saveStaffAction,
  saveStaffAvailabilityAction,
  saveVehicleAction,
  saveVehicleUnavailabilityAction,
  setStaffActiveAction,
  setVehicleActiveAction,
  type StaffInput,
  type VehicleInput,
} from "@/app/(dashboard)/resources/actions";
import { docStatus, VEHICLE_DOCS, VEHICLE_TYPES } from "@/lib/vehicles";
import { groupAvailabilityRuns, patternLabel, type AvailabilitySegment } from "@/lib/staff/availability";
import { StaffWallChart } from "@/components/resources/staff-wall-chart";

export interface StaffRow {
  id: string;
  full_name: string;
  staff_role: string;
  phone: string | null;
  email: string | null;
  // Pay — merged in from the office-scoped staff_pay table (not on the staff row).
  hourly_rate: number | null;
  weekly_guarantee: number | null;
  working_days: number[] | null;
  notes: string | null;
  is_active: boolean;
}

const PATTERN_CHIPS: { iw: number; l: string }[] = [
  { iw: 1, l: "Mon" },
  { iw: 2, l: "Tue" },
  { iw: 3, l: "Wed" },
  { iw: 4, l: "Thu" },
  { iw: 5, l: "Fri" },
  { iw: 6, l: "Sat" },
  { iw: 7, l: "Sun" },
];

export interface VehicleRow {
  id: string;
  name: string;
  vehicle_type: string;
  registration: string;
  tax_due: string | null;
  mot_due: string | null;
  insurance_renewal: string | null;
  last_service: string | null;
  service_due: string | null;
  cost_per_month: number | null;
  payment_day: number | null;
  end_of_term: string | null;
  notes: string | null;
  is_active: boolean;
}

export interface UnavailabilityRow {
  id: string;
  vehicle_id: string;
  start_date: string;
  end_date: string;
  reason: string;
  note: string | null;
}

export interface StaffAvailabilityRow {
  id: string;
  staff_id: string;
  date: string;
  status: string;
  note: string | null;
}

const OFFROAD_REASONS = [
  { value: "service", label: "Service" },
  { value: "mot", label: "MOT" },
  { value: "repair", label: "Repair" },
  { value: "other", label: "Other" },
] as const;
const REASON_LABEL = Object.fromEntries(OFFROAD_REASONS.map((r) => [r.value, r.label]));

const STAFF_ROLES = [
  { value: "crew", label: "Crew" },
  { value: "driver", label: "Driver" },
  { value: "estimator", label: "Estimator" },
  { value: "admin", label: "Admin" },
] as const;

const gbp = (n: number): string =>
  "£" + Number(n).toFixed(2).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const TYPE_LABEL = Object.fromEntries(VEHICLE_TYPES.map((t) => [t.value, t.label]));

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(`${d.slice(0, 10)}T00:00:00`);
  return isNaN(t.getTime())
    ? "—"
    : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Compact inclusive date range: "20 Jul" / "20–22 Jul" / "28 Jul–2 Aug". */
function fmtRange(start: string, end: string): string {
  const s = new Date(`${start.slice(0, 10)}T00:00:00`);
  const e = new Date(`${end.slice(0, 10)}T00:00:00`);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (start.slice(0, 10) === end.slice(0, 10)) return s.toLocaleDateString("en-GB", opts);
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  const from = sameMonth ? String(s.getDate()) : s.toLocaleDateString("en-GB", opts);
  return `${from}–${e.toLocaleDateString("en-GB", opts)}`;
}

const todayUk = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

/** Colour + verb for an availability run — green "Available", neutral "Off". */
function segMeta(status: string): { verb: string; cls: string } {
  return status === "available"
    ? { verb: "Available", cls: "bg-success-bg text-success" }
    : { verb: "Off", cls: "bg-muted text-mist-500" };
}

/** Tax / MOT / Insurance chip — the compliance improvement over iMVE. */
function DocChip({ label, date }: { label: string; date: string | null }) {
  const s = docStatus(date);
  const cls =
    s.state === "overdue"
      ? "bg-danger-bg text-danger"
      : s.state === "due"
        ? "bg-warn-bg text-warn"
        : s.state === "ok"
          ? "bg-success-bg text-success"
          : "bg-muted text-mist-400";
  const detail =
    s.state === "overdue"
      ? `${Math.abs(s.days!)}d overdue`
      : s.state === "due"
        ? s.days === 0
          ? "due today"
          : `${s.days}d left`
        : s.state === "ok"
          ? fmtDate(date)
          : "not set";
  const Icon = s.state === "overdue" || s.state === "due" ? ShieldAlert : ShieldCheck;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium", cls)}
      title={`${label}: ${fmtDate(date)}`}
    >
      <Icon className="size-3 shrink-0" strokeWidth={2} />
      {label} · {detail}
    </span>
  );
}

export function ResourcesView({
  staff,
  vehicles,
  unavailability,
  staffAvailability,
  today,
  initialTab,
}: {
  staff: StaffRow[];
  vehicles: VehicleRow[];
  unavailability: UnavailabilityRow[];
  staffAvailability: StaffAvailabilityRow[];
  today: string;
  initialTab: "staff" | "vehicles" | "availability";
}) {
  const [tab, setTab] = useState<"staff" | "vehicles" | "availability">(initialTab);
  const [staffEdit, setStaffEdit] = useState<StaffRow | "new" | null>(null);
  const [vehicleEdit, setVehicleEdit] = useState<VehicleRow | "new" | null>(null);

  const windowsByVehicle = useMemo(() => {
    const m = new Map<string, UnavailabilityRow[]>();
    for (const u of unavailability) {
      const list = m.get(u.vehicle_id) ?? [];
      list.push(u);
      m.set(u.vehicle_id, list);
    }
    return m;
  }, [unavailability]);

  // Availability collapsed into contiguous runs per staff member (a week's
  // holiday reads as one "21–25 Jul" line).
  const segmentsByStaff = useMemo(() => {
    const byStaff = new Map<string, StaffAvailabilityRow[]>();
    for (const a of staffAvailability) {
      const list = byStaff.get(a.staff_id) ?? [];
      list.push(a);
      byStaff.set(a.staff_id, list);
    }
    const m = new Map<string, AvailabilitySegment[]>();
    for (const [staffId, rows] of byStaff) m.set(staffId, groupAvailabilityRuns(rows));
    return m;
  }, [staffAvailability]);

  const counts = useMemo(
    () => ({
      staff: staff.filter((s) => s.is_active).length,
      vehicles: vehicles.filter((v) => v.is_active).length,
    }),
    [staff, vehicles],
  );

  const activeStaff = useMemo(() => staff.filter((s) => s.is_active), [staff]);

  const tabBtn = (
    key: "staff" | "vehicles" | "availability",
    Icon: typeof UserRound,
    label: string,
    count: number | null,
  ) => (
    <button type="button" onClick={() => setTab(key)} aria-pressed={tab === key} className={segmentedItemClass(tab === key)}>
      <Icon className="size-4" strokeWidth={1.75} />
      {label}
      {count !== null ? <span className={segmentedCountClass(tab === key)}>{count}</span> : null}
    </button>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className={segmentedTrackClass} role="group" aria-label="Resource type">
          {tabBtn("availability", CalendarDays, "Availability", null)}
          {tabBtn("staff", UserRound, "Staff", counts.staff)}
          {tabBtn("vehicles", Truck, "Vehicles", counts.vehicles)}
        </div>
        {tab !== "availability" ? (
          <Button
            className="ml-auto"
            onClick={() => (tab === "staff" ? setStaffEdit("new") : setVehicleEdit("new"))}
          >
            <Plus strokeWidth={1.75} />
            {tab === "staff" ? "Add staff" : "Add vehicle"}
          </Button>
        ) : null}
      </div>

      {tab === "availability" ? (
        activeStaff.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No crew yet"
            hint="Add crew under the Staff tab, then their availability shows here as a wall chart."
            className="mt-4 rounded-lg border border-border bg-card"
          />
        ) : (
          <StaffWallChart
            staff={activeStaff}
            staffAvailability={staffAvailability}
            today={today}
            onEditStaff={(id) => {
              const s = staff.find((x) => x.id === id);
              if (s) setStaffEdit(s);
            }}
          />
        )
      ) : null}

      {tab === "staff" ? (
        staff.length === 0 ? (
          <EmptyState
            icon={UserRound}
            title="No staff yet"
            hint="Add the crew so jobs can be assigned to them — use Add staff above."
            className="mt-4 rounded-lg border border-border bg-card"
          />
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {staff.map((s) => (
              <StaffCard
                key={s.id}
                s={s}
                segments={segmentsByStaff.get(s.id) ?? []}
                onEdit={() => setStaffEdit(s)}
              />
            ))}
          </div>
        )
      ) : tab === "vehicles" ? (
        vehicles.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="No vehicles yet"
            hint="Add the fleet to track MOT, tax and insurance — use Add vehicle above."
            className="mt-4 rounded-lg border border-border bg-card"
          />
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {vehicles.map((v) => (
              <VehicleCard
                key={v.id}
                v={v}
                windows={windowsByVehicle.get(v.id) ?? []}
                onEdit={() => setVehicleEdit(v)}
              />
            ))}
          </div>
        )
      ) : null}

      {staffEdit ? (
        <StaffDialog
          row={staffEdit === "new" ? null : staffEdit}
          segments={staffEdit && staffEdit !== "new" ? (segmentsByStaff.get(staffEdit.id) ?? []) : []}
          onClose={() => setStaffEdit(null)}
        />
      ) : null}
      {vehicleEdit ? (
        <VehicleDialog
          row={vehicleEdit === "new" ? null : vehicleEdit}
          windows={vehicleEdit && vehicleEdit !== "new" ? (windowsByVehicle.get(vehicleEdit.id) ?? []) : []}
          onClose={() => setVehicleEdit(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ staff */

function StaffCard({ s, segments, onEdit }: { s: StaffRow; segments: AvailabilitySegment[]; onEdit: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function toggleActive() {
    start(async () => {
      const res = await setStaffActiveAction(s.id, !s.is_active);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(s.is_active ? "Archived." : "Restored.");
        router.refresh();
      }
    });
  }

  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border border-border bg-card p-4", !s.is_active && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{s.full_name}</p>
          <span className="mt-1 inline-flex rounded-pill bg-muted px-2 py-0.5 text-[11px] font-medium capitalize text-mist-500">
            {s.staff_role}
          </span>
        </div>
        {!s.is_active ? (
          <span className="shrink-0 rounded-pill bg-mist-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mist-400">
            Archived
          </span>
        ) : null}
      </div>

      <div className="space-y-1 text-xs text-mist-500">
        <p className="flex items-center gap-2">
          <Phone className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
          <span className="truncate">{s.phone || "—"}</span>
        </p>
        <p className="truncate">{s.email || "—"}</p>
      </div>

      {segments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {segments.slice(0, 3).map((seg) => {
            const m = segMeta(seg.status);
            return (
              <span
                key={seg.ids[0]}
                className={cn("inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-medium", m.cls)}
                title={seg.note ?? undefined}
              >
                <CalendarDays className="size-3" strokeWidth={1.75} />
                {m.verb} {fmtRange(seg.start, seg.end)}
              </span>
            );
          })}
          {segments.length > 3 ? (
            <span className="inline-flex items-center rounded-pill bg-muted px-2 py-0.5 text-[11px] font-medium text-mist-400">
              +{segments.length - 3} more
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <span className="tabular text-xs text-mist-400">
          {s.hourly_rate != null ? `${gbp(s.hourly_rate)}/hr` : "no rate set"}
          {s.weekly_guarantee != null ? ` · ${gbp(s.weekly_guarantee)}/wk min` : ""}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${s.full_name}`}
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground"
          >
            <Pencil className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={toggleActive}
            disabled={pending}
            aria-label={s.is_active ? "Archive" : "Restore"}
            title={s.is_active ? "Archive" : "Restore"}
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : s.is_active ? (
              <Archive className="size-4" strokeWidth={1.75} />
            ) : (
              <ArchiveRestore className="size-4" strokeWidth={1.75} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function StaffDialog({
  row,
  segments,
  onClose,
}: {
  row: StaffRow | null;
  segments: AvailabilitySegment[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    full_name: row?.full_name ?? "",
    staff_role: (row?.staff_role ?? "crew") as StaffInput["staff_role"],
    phone: row?.phone ?? "",
    email: row?.email ?? "",
    hourly_rate: row?.hourly_rate != null ? String(row.hourly_rate) : "",
    weekly_guarantee: row?.weekly_guarantee != null ? String(row.weekly_guarantee) : "",
    notes: row?.notes ?? "",
  });
  const [pattern, setPattern] = useState<number[]>(() => row?.working_days ?? [1, 2, 3, 4, 5]);

  async function save() {
    setBusy(true);
    const res = await saveStaffAction({
      id: row?.id,
      full_name: v.full_name,
      staff_role: v.staff_role,
      phone: v.phone,
      email: v.email,
      hourly_rate: v.hourly_rate === "" ? "" : Number(v.hourly_rate),
      weekly_guarantee: v.weekly_guarantee === "" ? "" : Number(v.weekly_guarantee),
      working_days: pattern,
      notes: v.notes,
      is_active: row?.is_active ?? true,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(row ? "Staff updated." : "Staff added.");
    onClose();
    router.refresh();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{row ? "Edit staff" : "Add staff"}</DialogTitle>
          <DialogDescription>
            Crew records for job assignment — they don&apos;t need a login.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="st-name">Name</Label>
            <Input id="st-name" className="h-11" value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} placeholder="e.g. Jack" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="st-role">Role</Label>
              <Select value={v.staff_role} onValueChange={(val) => setV({ ...v, staff_role: val as StaffInput["staff_role"] })}>
                <SelectTrigger id="st-role" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STAFF_ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="st-rate">Hourly rate (£/hr)</Label>
              <Input id="st-rate" type="number" inputMode="decimal" min={0} step="0.01" className="h-11" value={v.hourly_rate} onChange={(e) => setV({ ...v, hourly_rate: e.target.value })} placeholder="15" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-guarantee">Weekly guarantee (£, optional)</Label>
            <Input id="st-guarantee" type="number" inputMode="decimal" min={0} step="0.01" className="h-11" value={v.weekly_guarantee} onChange={(e) => setV({ ...v, weekly_guarantee: e.target.value })} placeholder="e.g. 600" />
            <p className="text-xs text-mist-400">
              Paid this minimum each week even with no work (a retained crew member). Leave blank for pure hourly — paid only
              for hours worked. Rates are private: crew never see a colleague&apos;s.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="st-phone">Phone</Label>
              <Input id="st-phone" type="tel" inputMode="tel" className="h-11" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} placeholder="07…" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="st-email">Email</Label>
              <Input id="st-email" type="email" inputMode="email" className="h-11" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} placeholder="name@example.com" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Normal working days</Label>
            <div className="grid grid-cols-7 gap-1.5">
              {PATTERN_CHIPS.map((c) => {
                const on = pattern.includes(c.iw);
                return (
                  <button
                    key={c.iw}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setPattern((p) => (on ? p.filter((x) => x !== c.iw) : [...p, c.iw].sort((a, b) => a - b)))
                    }
                    className={cn(
                      "focus-ring flex h-10 items-center justify-center rounded-md border text-xs font-semibold transition-colors",
                      on ? "border-mm-red bg-mm-red text-white" : "border-input bg-card text-mist-400 hover:bg-muted",
                    )}
                  >
                    {c.l}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-mist-400">
              {patternLabel(pattern)} · retained crew are Mon–Fri; a casual gets just the days they do. Weekends they can
              work are offered per date.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="st-notes">Notes</Label>
            <textarea
              id="st-notes"
              rows={2}
              value={v.notes}
              onChange={(e) => setV({ ...v, notes: e.target.value })}
              className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder="Anything useful — licences, notes…"
            />
          </div>

          {row ? <StaffAvailabilityManager staffId={row.id} segments={segments} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            {row ? "Save" : "Add staff"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------- vehicles */

function VehicleCard({ v, windows, onEdit }: { v: VehicleRow; windows: UnavailabilityRow[]; onEdit: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const today = todayUk();
  const upcoming = windows
    .filter((w) => w.end_date.slice(0, 10) >= today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  function toggleActive() {
    start(async () => {
      const res = await setVehicleActiveAction(v.id, !v.is_active);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(v.is_active ? "Archived." : "Restored.");
        router.refresh();
      }
    });
  }

  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border border-border bg-card p-4", !v.is_active && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{v.name}</p>
          <p className="mt-0.5 text-xs text-mist-400">{TYPE_LABEL[v.vehicle_type] ?? v.vehicle_type}</p>
        </div>
        {v.registration ? (
          <span className="tabular shrink-0 rounded border border-border bg-[#FDD835]/20 px-2 py-0.5 text-xs font-bold tracking-wider text-foreground">
            {v.registration}
          </span>
        ) : null}
      </div>

      {/* compliance chips — amber ≤30d, red overdue */}
      <div className="flex flex-wrap gap-1.5">
        {VEHICLE_DOCS.map((d) => (
          <DocChip key={d.key} label={d.label} date={v[d.key]} />
        ))}
        <DocChip label="Service" date={v.service_due} />
      </div>

      {upcoming.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {upcoming.map((w) => (
            <span
              key={w.id}
              className="inline-flex items-center gap-1 rounded-pill bg-muted px-2 py-0.5 text-[11px] font-medium text-mist-500"
              title={w.note ?? undefined}
            >
              <Wrench className="size-3" strokeWidth={1.75} />
              Off-road {fmtRange(w.start_date, w.end_date)} ({REASON_LABEL[w.reason] ?? "Off-road"})
            </span>
          ))}
        </div>
      ) : null}

      <div className="space-y-1 text-xs text-mist-500">
        <p>Last service: {fmtDate(v.last_service)}</p>
        {v.end_of_term ? <p>End of term: {fmtDate(v.end_of_term)}</p> : null}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <span className="tabular text-xs text-mist-400">
          {v.cost_per_month != null
            ? `${gbp(v.cost_per_month)}/mo${v.payment_day ? ` · day ${v.payment_day}` : ""}`
            : "no monthly cost"}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${v.name}`}
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground"
          >
            <Pencil className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={toggleActive}
            disabled={pending}
            aria-label={v.is_active ? "Archive" : "Restore"}
            title={v.is_active ? "Archive" : "Restore"}
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : v.is_active ? (
              <Archive className="size-4" strokeWidth={1.75} />
            ) : (
              <ArchiveRestore className="size-4" strokeWidth={1.75} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function VehicleDialog({
  row,
  windows,
  onClose,
}: {
  row: VehicleRow | null;
  windows: UnavailabilityRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    name: row?.name ?? "",
    vehicle_type: (row?.vehicle_type ?? "luton") as VehicleInput["vehicle_type"],
    registration: row?.registration ?? "",
    tax_due: row?.tax_due?.slice(0, 10) ?? "",
    mot_due: row?.mot_due?.slice(0, 10) ?? "",
    insurance_renewal: row?.insurance_renewal?.slice(0, 10) ?? "",
    last_service: row?.last_service?.slice(0, 10) ?? "",
    service_due: row?.service_due?.slice(0, 10) ?? "",
    cost_per_month: row?.cost_per_month != null ? String(row.cost_per_month) : "",
    payment_day: row?.payment_day != null ? String(row.payment_day) : "",
    end_of_term: row?.end_of_term?.slice(0, 10) ?? "",
    notes: row?.notes ?? "",
  });
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });

  async function save() {
    setBusy(true);
    const res = await saveVehicleAction({
      id: row?.id,
      name: v.name,
      vehicle_type: v.vehicle_type,
      registration: v.registration,
      tax_due: v.tax_due,
      mot_due: v.mot_due,
      insurance_renewal: v.insurance_renewal,
      last_service: v.last_service,
      service_due: v.service_due,
      cost_per_month: v.cost_per_month === "" ? "" : Number(v.cost_per_month),
      payment_day: v.payment_day === "" ? "" : Number(v.payment_day),
      end_of_term: v.end_of_term,
      notes: v.notes,
      is_active: row?.is_active ?? true,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(row ? "Vehicle updated." : "Vehicle added.");
    onClose();
    router.refresh();
  }

  const dateField = (id: keyof typeof v, label: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`vh-${id}`}>{label}</Label>
      <Input
        id={`vh-${id}`}
        type="date"
        className="h-11"
        value={v[id] as string}
        onChange={(e) => set({ [id]: e.target.value } as Partial<typeof v>)}
      />
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{row ? "Edit vehicle" : "Add vehicle"}</DialogTitle>
          <DialogDescription>
            Fleet record — MOT, tax and insurance dates drive the compliance chips.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="vh-name">Name / callsign</Label>
              <Input id="vh-name" className="h-11" value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Luton 1" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="vh-type">Type</Label>
              <Select value={v.vehicle_type} onValueChange={(val) => set({ vehicle_type: val as VehicleInput["vehicle_type"] })}>
                <SelectTrigger id="vh-type" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VEHICLE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="vh-reg">Registration</Label>
            <Input id="vh-reg" className="h-11 uppercase" value={v.registration} onChange={(e) => set({ registration: e.target.value })} placeholder="AB12 CDE" />
          </div>

          <p className="eyebrow pt-1">Compliance dates</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {dateField("tax_due", "Tax due")}
            {dateField("mot_due", "MOT due")}
            {dateField("insurance_renewal", "Insurance renewal")}
            {dateField("service_due", "Service due")}
            {dateField("last_service", "Last service")}
          </div>

          <p className="eyebrow pt-1">Finance</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="vh-cost">Cost / month (£)</Label>
              <Input id="vh-cost" type="number" inputMode="decimal" min={0} step="0.01" className="h-11" value={v.cost_per_month} onChange={(e) => set({ cost_per_month: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="vh-payday">Payment day</Label>
              <Input id="vh-payday" type="number" inputMode="numeric" min={1} max={31} className="h-11" value={v.payment_day} onChange={(e) => set({ payment_day: e.target.value })} placeholder="1–31" />
            </div>
            {dateField("end_of_term", "End of term")}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="vh-notes">Notes</Label>
            <textarea
              id="vh-notes"
              rows={2}
              value={v.notes}
              onChange={(e) => set({ notes: e.target.value })}
              className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder="Tail lift, dents, keys…"
            />
          </div>

          {row ? <OffRoadManager vehicleId={row.id} windows={windows} /> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            {row ? "Save" : "Add vehicle"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Off-road / garage windows for one vehicle — list + add + remove. Only shown
 *  when editing an existing vehicle (a window needs the vehicle's id). */
function OffRoadManager({ vehicleId, windows }: { vehicleId: string; windows: UnavailabilityRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState<(typeof OFFROAD_REASONS)[number]["value"]>("service");
  const [note, setNote] = useState("");

  const sorted = [...windows].sort((a, b) => b.start_date.localeCompare(a.start_date));

  async function add() {
    if (!start || !end) {
      toast.error("Pick a start and end date.");
      return;
    }
    setBusy(true);
    const res = await saveVehicleUnavailabilityAction({
      vehicle_id: vehicleId,
      start_date: start,
      end_date: end,
      reason,
      note,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Off-road window added.");
    setStart("");
    setEnd("");
    setNote("");
    setReason("service");
    router.refresh();
  }

  async function remove(id: string) {
    const res = await deleteVehicleUnavailabilityAction(id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Removed.");
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <Wrench className="size-4 text-mist-400" strokeWidth={1.75} />
        <p className="text-sm font-semibold text-foreground">Off-road / garage</p>
      </div>
      <p className="mt-0.5 text-xs text-mist-400">
        Days the van is in the garage or off the road. It drops out of Job Board capacity across these dates.
      </p>

      {sorted.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {sorted.map((w) => (
            <li
              key={w.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
            >
              <span className="min-w-0 truncate text-foreground">
                <span className="font-medium">{fmtRange(w.start_date, w.end_date)}</span>{" "}
                <span className="text-mist-400">
                  · {REASON_LABEL[w.reason] ?? "Off-road"}
                  {w.note ? ` · ${w.note}` : ""}
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(w.id)}
                aria-label="Remove off-road window"
                className="focus-ring flex size-7 shrink-0 items-center justify-center rounded text-mist-400 hover:bg-danger-bg hover:text-danger"
              >
                <Trash2 className="size-3.5" strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor="or-start" className="text-xs">From</Label>
          <Input id="or-start" type="date" className="h-10" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="or-end" className="text-xs">To</Label>
          <Input id="or-end" type="date" className="h-10" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="or-reason" className="text-xs">Reason</Label>
          <Select value={reason} onValueChange={(val) => setReason(val as typeof reason)}>
            <SelectTrigger id="or-reason" className="h-10 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OFFROAD_REASONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="or-note" className="text-xs">Note (optional)</Label>
          <Input id="or-note" className="h-10" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Garage, ref…" />
        </div>
      </div>
      <Button type="button" variant="outline" onClick={add} disabled={busy} className="mt-2">
        {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Plus className="size-4" strokeWidth={1.75} />}
        Book off-road
      </Button>
    </div>
  );
}

/** Availability for one crew member — the office view. Lets the office book a day
 *  off / holiday (a single date or a range) or mark a weekend they can work, on
 *  behalf of login-less crew or anyone. Same table + defaults as the crew portal;
 *  feeds the Job Board. Only shown when editing an existing staff member. */
function StaffAvailabilityManager({ staffId, segments }: { staffId: string; segments: AvailabilitySegment[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [status, setStatus] = useState<"unavailable" | "available">("unavailable");
  const [note, setNote] = useState("");

  async function add() {
    if (!start) {
      toast.error("Pick a date.");
      return;
    }
    if (end && end < start) {
      toast.error("The end date can’t be before the start.");
      return;
    }
    setBusy(true);
    const res = await saveStaffAvailabilityAction({ staff_id: staffId, start_date: start, end_date: end, status, note });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(status === "unavailable" ? "Time off saved." : "Availability saved.");
    setStart("");
    setEnd("");
    setNote("");
    setStatus("unavailable");
    router.refresh();
  }

  async function remove(ids: string[]) {
    setRemoving(ids[0]);
    const res = await deleteStaffAvailabilityAction(ids);
    setRemoving(null);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Removed.");
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <CalendarDays className="size-4 text-mist-400" strokeWidth={1.75} />
        <p className="text-sm font-semibold text-foreground">Availability</p>
      </div>
      <p className="mt-0.5 text-xs text-mist-400">
        Crew work Mon–Fri by default. Book a day off / holiday, or mark a weekend they can work. Feeds the Job Board.
      </p>

      {segments.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {segments.map((seg) => {
            const m = segMeta(seg.status);
            return (
              <li
                key={seg.ids[0]}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate text-foreground">
                  <span className={cn("mr-1 rounded-pill px-1.5 py-0.5 text-[10px] font-semibold", m.cls)}>{m.verb}</span>
                  <span className="font-medium">{fmtRange(seg.start, seg.end)}</span>
                  {seg.note ? <span className="text-mist-400"> · {seg.note}</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => remove(seg.ids)}
                  disabled={removing === seg.ids[0]}
                  aria-label="Remove availability"
                  className="focus-ring flex size-7 shrink-0 items-center justify-center rounded text-mist-400 hover:bg-danger-bg hover:text-danger disabled:opacity-50"
                >
                  {removing === seg.ids[0] ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <Trash2 className="size-3.5" strokeWidth={1.75} />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor="sa-start" className="text-xs">
            Date (or from)
          </Label>
          <Input id="sa-start" type="date" className="h-10" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="sa-end" className="text-xs">
            To (optional)
          </Label>
          <Input id="sa-end" type="date" className="h-10" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="sa-status" className="text-xs">
            Status
          </Label>
          <Select value={status} onValueChange={(val) => setStatus(val as typeof status)}>
            <SelectTrigger id="sa-status" className="h-10 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unavailable">Off / holiday</SelectItem>
              <SelectItem value="available">Available (e.g. weekend)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="sa-note" className="text-xs">
            Note (optional)
          </Label>
          <Input id="sa-note" className="h-10" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Holiday, appointment…" />
        </div>
      </div>
      <Button type="button" variant="outline" onClick={add} disabled={busy} className="mt-2">
        {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Plus className="size-4" strokeWidth={1.75} />}
        Save availability
      </Button>
    </div>
  );
}
