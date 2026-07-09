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
  Loader2,
  Pencil,
  Phone,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Truck,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  saveStaffAction,
  saveVehicleAction,
  setStaffActiveAction,
  setVehicleActiveAction,
  type StaffInput,
  type VehicleInput,
} from "@/app/(dashboard)/resources/actions";
import { docStatus, VEHICLE_DOCS, VEHICLE_TYPES } from "@/lib/vehicles";

export interface StaffRow {
  id: string;
  full_name: string;
  staff_role: string;
  phone: string | null;
  email: string | null;
  day_rate: number | null;
  notes: string | null;
  is_active: boolean;
}

export interface VehicleRow {
  id: string;
  name: string;
  vehicle_type: string;
  registration: string;
  tax_due: string | null;
  mot_due: string | null;
  insurance_renewal: string | null;
  last_service: string | null;
  cost_per_month: number | null;
  payment_day: number | null;
  end_of_term: string | null;
  notes: string | null;
  is_active: boolean;
}

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
  initialTab,
}: {
  staff: StaffRow[];
  vehicles: VehicleRow[];
  initialTab: "staff" | "vehicles";
}) {
  const [tab, setTab] = useState<"staff" | "vehicles">(initialTab);
  const [staffEdit, setStaffEdit] = useState<StaffRow | "new" | null>(null);
  const [vehicleEdit, setVehicleEdit] = useState<VehicleRow | "new" | null>(null);

  const counts = useMemo(
    () => ({
      staff: staff.filter((s) => s.is_active).length,
      vehicles: vehicles.filter((v) => v.is_active).length,
    }),
    [staff, vehicles],
  );

  const tabBtn = (key: "staff" | "vehicles", Icon: typeof UserRound, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      aria-pressed={tab === key}
      className={cn(
        "focus-ring inline-flex min-h-9 items-center gap-1.5 px-3 text-sm font-medium transition-colors",
        tab === key ? "bg-mm-red-tint text-mm-red-deep" : "bg-card text-mist-500 hover:bg-muted",
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
      {label}
      <span className="tabular rounded-pill bg-muted px-1.5 text-xs text-mist-400">{count}</span>
    </button>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-input" role="group" aria-label="Resource type">
          {tabBtn("staff", UserRound, "Staff", counts.staff)}
          <span className="w-px bg-border" />
          {tabBtn("vehicles", Truck, "Vehicles", counts.vehicles)}
        </div>
        <Button
          className="ml-auto"
          onClick={() => (tab === "staff" ? setStaffEdit("new") : setVehicleEdit("new"))}
        >
          <Plus strokeWidth={1.75} />
          {tab === "staff" ? "Add staff" : "Add vehicle"}
        </Button>
      </div>

      {tab === "staff" ? (
        staff.length === 0 ? (
          <Empty text="No staff yet. Add the crew so jobs can be assigned to them." />
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {staff.map((s) => (
              <StaffCard key={s.id} s={s} onEdit={() => setStaffEdit(s)} />
            ))}
          </div>
        )
      ) : vehicles.length === 0 ? (
        <Empty text="No vehicles yet. Add the fleet to track MOT, tax and insurance." />
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {vehicles.map((v) => (
            <VehicleCard key={v.id} v={v} onEdit={() => setVehicleEdit(v)} />
          ))}
        </div>
      )}

      {staffEdit ? (
        <StaffDialog row={staffEdit === "new" ? null : staffEdit} onClose={() => setStaffEdit(null)} />
      ) : null}
      {vehicleEdit ? (
        <VehicleDialog row={vehicleEdit === "new" ? null : vehicleEdit} onClose={() => setVehicleEdit(null)} />
      ) : null}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="mt-4 rounded-lg border border-border bg-card px-5 py-12 text-center text-sm text-mist-400">
      {text}
    </div>
  );
}

/* ------------------------------------------------------------------ staff */

function StaffCard({ s, onEdit }: { s: StaffRow; onEdit: () => void }) {
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

      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <span className="tabular text-xs text-mist-400">{s.day_rate != null ? `${gbp(s.day_rate)}/day` : "no day rate"}</span>
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

function StaffDialog({ row, onClose }: { row: StaffRow | null; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    full_name: row?.full_name ?? "",
    staff_role: (row?.staff_role ?? "crew") as StaffInput["staff_role"],
    phone: row?.phone ?? "",
    email: row?.email ?? "",
    day_rate: row?.day_rate != null ? String(row.day_rate) : "",
    notes: row?.notes ?? "",
  });

  async function save() {
    setBusy(true);
    const res = await saveStaffAction({
      id: row?.id,
      full_name: v.full_name,
      staff_role: v.staff_role,
      phone: v.phone,
      email: v.email,
      day_rate: v.day_rate === "" ? "" : Number(v.day_rate),
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
      <DialogContent>
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
              <Label htmlFor="st-rate">Day rate (£)</Label>
              <Input id="st-rate" type="number" inputMode="decimal" min={0} step="0.01" className="h-11" value={v.day_rate} onChange={(e) => setV({ ...v, day_rate: e.target.value })} placeholder="120" />
            </div>
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
            <Label htmlFor="st-notes">Notes</Label>
            <textarea
              id="st-notes"
              rows={2}
              value={v.notes}
              onChange={(e) => setV({ ...v, notes: e.target.value })}
              className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder="Anything useful — licences, availability…"
            />
          </div>
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

function VehicleCard({ v, onEdit }: { v: VehicleRow; onEdit: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();

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
      </div>

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

function VehicleDialog({ row, onClose }: { row: VehicleRow | null; onClose: () => void }) {
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
