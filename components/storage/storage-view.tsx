"use client";

/**
 * Storage — sites → units → lets (iMVE clone-and-improve, docs/imve-discovery.md §3).
 * Occupancy is derived: a unit is occupied while it has an open let (end_date null),
 * so status can never drift from the let history. Billing stays manual in Zoho for
 * now — a let records the agreed rate, phase 2 wires recurring invoices.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Box,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Search,
  UserRound,
  Warehouse,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  endLetAction,
  reopenLetAction,
  saveSiteAction,
  saveUnitAction,
  setSiteActiveAction,
  setUnitActiveAction,
  startLetAction,
  type SiteInput,
  type UnitInput,
} from "@/app/(dashboard)/storage/actions";
import { defaultCuft, occupiedUnitIds, siteOccupancy, UNIT_TYPES, type UnitType } from "@/lib/storage-units";
import { letDefaultsForUnitType, type StorageRates } from "@/lib/storage-rates";
import { ManageLetDialog } from "@/components/storage/manage-let-dialog";

export interface SiteRow {
  id: string;
  name: string;
  address: string;
  notes: string | null;
  is_active: boolean;
}

export interface UnitRow {
  id: string;
  site_id: string;
  code: string;
  name: string;
  unit_type: string;
  size_cuft: number | null;
  notes: string | null;
  is_active: boolean;
}

export interface LetInvoice {
  id: string;
  period_start: string;
  amount: number;
  status: string;
  /** period | minimum | arrears | final (crate daily-arrears model). */
  kind: string;
  zoho_invoice_number: string | null;
  zoho_invoice_url: string | null;
}

export interface HandlingEventRow {
  id: string;
  event_date: string;
  kind: string; // in | out | access
  amount: number;
  billed: boolean;
}

export interface LetRow {
  id: string;
  unit_id: string;
  client_id: string;
  client_name: string;
  /** Client's email, if on file — the "Email signing link" button needs it. */
  client_email: string | null;
  start_date: string;
  end_date: string | null;
  rate: number | null;
  rate_period: string;
  /** 'period' (containers/rooms) | 'crate_daily' (28-day min + daily arrears). */
  billing_model: string;
  min_days: number | null;
  min_amount: number | null;
  notes: string | null;
  billing_paused: boolean;
  /** kind='storage' signature on this let, if collected. */
  agreement: { signer: string; channel: string } | null;
  /** Next date the billing cron will raise an invoice (open lets only). */
  next_invoice: string | null;
  /** Most recent invoices, newest first. */
  invoices: LetInvoice[];
  /** Handling events (crate lets), newest first. */
  handling_events: HandlingEventRow[];
}

export interface PickerClient {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

const TYPE_LABEL = Object.fromEntries(UNIT_TYPES.map((t) => [t.value, t.label]));

const gbp = (n: number): string =>
  "£" + Number(n).toFixed(2).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(`${d.slice(0, 10)}T00:00:00`);
  return isNaN(t.getTime())
    ? "—"
    : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

export function StorageView({
  sites,
  units,
  lets,
  clients,
  rates,
}: {
  sites: SiteRow[];
  units: UnitRow[];
  lets: LetRow[];
  clients: PickerClient[];
  rates: StorageRates;
}) {
  const firstActive = sites.find((s) => s.is_active) ?? sites[0] ?? null;
  const [siteId, setSiteId] = useState<string | null>(firstActive?.id ?? null);
  const [filter, setFilter] = useState<"all" | "available" | "occupied">("all");
  const [q, setQ] = useState("");
  const [siteEdit, setSiteEdit] = useState<SiteRow | "new" | null>(null);
  const [unitEdit, setUnitEdit] = useState<UnitRow | "new" | null>(null);
  const [letFor, setLetFor] = useState<UnitRow | null>(null);
  const [endFor, setEndFor] = useState<{ unit: UnitRow; let: LetRow } | null>(null);
  const [manageFor, setManageFor] = useState<{ unit: UnitRow; let: LetRow } | null>(null);

  const occupied = useMemo(() => occupiedUnitIds(lets), [lets]);
  const openLetByUnit = useMemo(() => {
    const m = new Map<string, LetRow>();
    for (const l of lets) if (l.end_date == null) m.set(l.unit_id, l);
    return m;
  }, [lets]);
  // Latest ENDED let per unit — the "reopen" recovery for an accidental end.
  const lastEndedByUnit = useMemo(() => {
    const m = new Map<string, LetRow>();
    for (const l of lets) {
      if (!l.end_date) continue;
      const cur = m.get(l.unit_id);
      if (!cur || l.end_date > (cur.end_date ?? "")) m.set(l.unit_id, l);
    }
    return m;
  }, [lets]);

  // Fall back to the first active site so the units section appears as soon as
  // the FIRST site is created (the initial useState ran while there were none).
  const site = sites.find((s) => s.id === siteId) ?? firstActive;
  const selectedId = site?.id ?? null;

  const siteUnits = useMemo(() => {
    if (!selectedId) return [];
    const needle = q.trim().toLowerCase();
    return units
      .filter((u) => u.site_id === selectedId)
      .filter((u) => {
        if (filter === "occupied" && !occupied.has(u.id)) return false;
        if (filter === "available" && (occupied.has(u.id) || !u.is_active)) return false;
        if (!needle) return true;
        const let_ = openLetByUnit.get(u.id);
        return [u.code, u.name, TYPE_LABEL[u.unit_type] ?? "", let_?.client_name ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      });
  }, [units, selectedId, filter, q, occupied, openLetByUnit]);

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------ sites */}
      <div>
        <div className="flex items-center justify-between">
          <p className="eyebrow">Sites</p>
          <Button variant="outline" size="sm" onClick={() => setSiteEdit("new")}>
            <Plus strokeWidth={1.75} />
            Add site
          </Button>
        </div>
        {sites.length === 0 ? (
          <div className="mt-3 rounded-lg border border-border bg-card">
            <EmptyState
              icon={Warehouse}
              title="No storage sites yet"
              hint="Add the yard or warehouse where the containers live — use Add site above."
            />
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sites.map((s) => (
              <SiteCard
                key={s.id}
                s={s}
                occ={siteOccupancy(units, lets, s.id)}
                selected={s.id === selectedId}
                onSelect={() => setSiteId(s.id)}
                onEdit={() => setSiteEdit(s)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------ units */}
      {site ? (
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="eyebrow">Units at {site.name}</p>
            <div className="inline-flex overflow-hidden rounded-md border border-input" role="group" aria-label="Unit status filter">
              {(
                [
                  ["all", "All"],
                  ["available", "Available"],
                  ["occupied", "Occupied"],
                ] as const
              ).map(([key, label], i) => (
                <span key={key} className="inline-flex">
                  {i > 0 ? <span className="w-px bg-border" /> : null}
                  <button
                    type="button"
                    onClick={() => setFilter(key)}
                    aria-pressed={filter === key}
                    className={cn(
                      "focus-ring min-h-9 px-3 text-sm font-medium transition-colors",
                      filter === key ? "bg-mm-red text-white" : "bg-card text-mist-500 hover:bg-muted",
                    )}
                  >
                    {label}
                  </button>
                </span>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-mist-400" strokeWidth={1.75} />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search units or clients…"
                className="h-9 w-56 pl-8"
                aria-label="Search units"
              />
            </div>
            <Button className="ml-auto" onClick={() => setUnitEdit("new")}>
              <Plus strokeWidth={1.75} />
              Add unit
            </Button>
          </div>

          {siteUnits.length === 0 ? (
            <div className="mt-4 rounded-lg border border-border bg-card">
              {units.some((u) => u.site_id === site.id) ? (
                <EmptyState
                  icon={Box}
                  title="No units match"
                  hint="No units match that filter — change the filter or clear the search."
                />
              ) : (
                <EmptyState
                  icon={Box}
                  title="No units yet"
                  hint="Add the containers or rooms at this site — use Add unit above."
                />
              )}
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {siteUnits.map((u) => (
                <UnitCard
                  key={u.id}
                  u={u}
                  openLet={openLetByUnit.get(u.id) ?? null}
                  onEdit={() => setUnitEdit(u)}
                  onAssign={() => setLetFor(u)}
                  onEnd={(l) => setEndFor({ unit: u, let: l })}
                  onManage={(l) => setManageFor({ unit: u, let: l })}
                  lastEndedLet={lastEndedByUnit.get(u.id) ?? null}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {siteEdit ? (
        <SiteDialog row={siteEdit === "new" ? null : siteEdit} onClose={() => setSiteEdit(null)} />
      ) : null}
      {unitEdit && site ? (
        <UnitDialog
          row={unitEdit === "new" ? null : unitEdit}
          siteId={site.id}
          siteName={site.name}
          onClose={() => setUnitEdit(null)}
        />
      ) : null}
      {letFor ? <LetDialog unit={letFor} clients={clients} rates={rates} onClose={() => setLetFor(null)} /> : null}
      {endFor ? <EndLetDialog unit={endFor.unit} let_={endFor.let} rates={rates} onClose={() => setEndFor(null)} /> : null}
      {manageFor ? (
        <ManageLetDialog unit={manageFor.unit} let_={manageFor.let} rates={rates} onClose={() => setManageFor(null)} />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- sites */

function SiteCard({
  s,
  occ,
  selected,
  onSelect,
  onEdit,
}: {
  s: SiteRow;
  occ: { total: number; occupied: number; available: number };
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function toggleActive() {
    start(async () => {
      const res = await setSiteActiveAction(s.id, !s.is_active);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(s.is_active ? "Site archived." : "Site restored.");
        router.refresh();
      }
    });
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      aria-pressed={selected}
      className={cn(
        "focus-ring flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors",
        selected ? "border-mm-red shadow-sm" : "border-border hover:bg-muted/50",
        !s.is_active && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Warehouse className={cn("size-4 shrink-0", selected ? "text-mm-red" : "text-mist-400")} strokeWidth={1.75} />
          <p className="truncate text-sm font-semibold text-foreground">{s.name}</p>
        </div>
        {!s.is_active ? (
          <span className="shrink-0 rounded-pill bg-mist-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mist-400">
            Archived
          </span>
        ) : null}
      </div>
      {s.address ? (
        <p className="flex items-center gap-1.5 text-xs text-mist-500">
          <MapPin className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
          <span className="truncate">{s.address}</span>
        </p>
      ) : null}
      <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5">
        <span className="tabular text-xs text-mist-500">
          {occ.total === 0 ? (
            "no units"
          ) : (
            <>
              <span className={cn("font-semibold", occ.available === 0 ? "text-mm-red-deep" : "text-foreground")}>
                {occ.available}
              </span>{" "}
              of {occ.total} available
            </>
          )}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            aria-label={`Edit ${s.name}`}
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground"
          >
            <Pencil className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleActive();
            }}
            disabled={pending}
            aria-label={s.is_active ? "Archive site" : "Restore site"}
            title={s.is_active ? "Archive site" : "Restore site"}
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

function SiteDialog({ row, onClose }: { row: SiteRow | null; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({ name: row?.name ?? "", address: row?.address ?? "", notes: row?.notes ?? "" });

  async function save() {
    setBusy(true);
    const res = await saveSiteAction({
      id: row?.id,
      name: v.name,
      address: v.address,
      notes: v.notes,
      is_active: row?.is_active ?? true,
    } satisfies SiteInput);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(row ? "Site updated." : "Site added.");
    onClose();
    router.refresh();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{row ? "Edit site" : "Add site"}</DialogTitle>
          <DialogDescription>A storage location — the yard, a warehouse, a unit block.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ss-name">Name</Label>
            <Input id="ss-name" className="h-11" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Shaftesbury yard" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ss-addr">Address</Label>
            <Input id="ss-addr" className="h-11" value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} placeholder="Ash Cottage, Sherborne Causeway…" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ss-notes">Notes</Label>
            <textarea
              id="ss-notes"
              rows={2}
              value={v.notes}
              onChange={(e) => setV({ ...v, notes: e.target.value })}
              className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder="Access, gate codes, anything useful…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            {row ? "Save" : "Add site"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------- units */

function UnitCard({
  u,
  openLet,
  onEdit,
  onAssign,
  onEnd,
  onManage,
  lastEndedLet,
}: {
  u: UnitRow;
  openLet: LetRow | null;
  onEdit: () => void;
  onAssign: () => void;
  onEnd: (l: LetRow) => void;
  onManage: (l: LetRow) => void;
  lastEndedLet: LetRow | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const occupied = openLet != null;

  function toggleActive() {
    start(async () => {
      const res = await setUnitActiveAction(u.id, !u.is_active);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(u.is_active ? "Unit archived." : "Unit restored.");
        router.refresh();
      }
    });
  }

  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border border-border bg-card p-4", !u.is_active && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Box className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
            <p className="truncate text-sm font-semibold text-foreground">{u.code || u.name || "Unit"}</p>
          </div>
          <p className="mt-0.5 text-xs text-mist-400">
            {u.code && u.name ? `${u.name} · ` : ""}
            {TYPE_LABEL[u.unit_type] ?? u.unit_type}
            {u.size_cuft != null ? ` · ${Number(u.size_cuft)} cu ft` : ""}
          </p>
        </div>
        {!u.is_active ? (
          <span className="shrink-0 rounded-pill bg-mist-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mist-400">
            Archived
          </span>
        ) : (
          <span
            className={cn(
              "shrink-0 rounded-pill px-2 py-0.5 text-[11px] font-medium",
              occupied ? "bg-mm-red text-white" : "bg-success-bg text-success",
            )}
          >
            {occupied ? "Occupied" : "Available"}
          </span>
        )}
      </div>

      {occupied && openLet ? (
        <div className="rounded-md bg-muted/60 px-3 py-2 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <UserRound className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
            <span className="truncate">{openLet.client_name}</span>
          </p>
          <p className="mt-0.5 text-mist-500">
            since {fmtDate(openLet.start_date)}
            {openLet.rate != null
              ? ` · ${gbp(openLet.rate)}/${openLet.rate_period === "month" ? "mo" : openLet.rate_period === "day" ? "day" : "wk"}`
              : ""}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {openLet.agreement ? (
              <span className="rounded-pill bg-success-bg px-2 py-0.5 text-[10px] font-semibold text-success">
                Agreement signed
              </span>
            ) : (
              <span className="rounded-pill border border-warn-border bg-warn-bg px-2 py-0.5 text-[10px] font-semibold text-warn">
                Agreement unsigned
              </span>
            )}
            {openLet.billing_paused ? (
              <span className="rounded-pill border border-warn-border bg-warn-bg px-2 py-0.5 text-[10px] font-semibold text-warn">
                Billing paused
              </span>
            ) : openLet.next_invoice ? (
              <span className="rounded-pill bg-muted px-2 py-0.5 text-[10px] font-medium text-mist-500">
                Next invoice {fmtDate(openLet.next_invoice)}
              </span>
            ) : null}
          </p>
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        {u.is_active ? (
          occupied && openLet ? (
            <span className="flex gap-2">
              <Button size="sm" onClick={() => onManage(openLet)} className="bg-mm-red text-white hover:bg-mm-red-deep">
                Manage
              </Button>
              <Button variant="outline" size="sm" onClick={() => onEnd(openLet)}>
                End let
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Button size="sm" onClick={onAssign} className="bg-mm-red text-white hover:bg-mm-red-deep">
                Assign client
              </Button>
              {lastEndedLet ? <ReopenLetLink let_={lastEndedLet} /> : null}
            </span>
          )
        ) : (
          <span />
        )}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${u.code || u.name}`}
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground"
          >
            <Pencil className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={toggleActive}
            disabled={pending}
            aria-label={u.is_active ? "Archive unit" : "Restore unit"}
            title={u.is_active ? "Archive unit" : "Restore unit"}
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : u.is_active ? (
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

/** Undo an accidental End-let: reopens the unit's most recent ended let. */
function ReopenLetLink({ let_ }: { let_: LetRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  function reopen() {
    start(async () => {
      const res = await reopenLetAction(let_.id);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`${let_.client_name}'s let reopened — billing resumes from where it left off.`);
        router.refresh();
      }
    });
  }
  return (
    <button
      type="button"
      onClick={reopen}
      disabled={pending}
      title={`Reopen ${let_.client_name}'s let (ended ${fmtDate(let_.end_date)})`}
      className="focus-ring text-xs font-medium text-mist-400 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
    >
      {pending ? "Reopening…" : "Reopen last let"}
    </button>
  );
}

function UnitDialog({
  row,
  siteId,
  siteName,
  onClose,
}: {
  row: UnitRow | null;
  siteId: string;
  siteName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    code: row?.code ?? "",
    name: row?.name ?? "",
    unit_type: (row?.unit_type ?? "crate_250") as UnitType,
    size_cuft: row?.size_cuft != null ? String(Number(row.size_cuft)) : String(defaultCuft("crate_250") ?? ""),
    notes: row?.notes ?? "",
  });

  function onType(val: UnitType) {
    // Auto-fill size from the type (iMVE pattern) unless the user typed a custom size.
    const prevDefault = defaultCuft(v.unit_type);
    const keepCustom = v.size_cuft !== "" && Number(v.size_cuft) !== prevDefault;
    setV({ ...v, unit_type: val, size_cuft: keepCustom ? v.size_cuft : String(defaultCuft(val) ?? "") });
  }

  async function save() {
    setBusy(true);
    const res = await saveUnitAction({
      id: row?.id,
      site_id: row ? row.site_id : siteId,
      code: v.code,
      name: v.name,
      unit_type: v.unit_type,
      size_cuft: v.size_cuft === "" ? "" : Number(v.size_cuft),
      notes: v.notes,
      is_active: row?.is_active ?? true,
    } satisfies UnitInput);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(row ? "Unit updated." : "Unit added.");
    onClose();
    router.refresh();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{row ? "Edit unit" : "Add unit"}</DialogTitle>
          <DialogDescription>A container, crate or room at {siteName}.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="su-code">Code</Label>
              <Input id="su-code" className="h-11 uppercase" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} placeholder="e.g. 20FT-01" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="su-name">Name</Label>
              <Input id="su-name" className="h-11" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="optional" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="su-type">Type</Label>
              <Select value={v.unit_type} onValueChange={(val) => onType(val as UnitType)}>
                <SelectTrigger id="su-type" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNIT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="su-size">Size (cu ft)</Label>
              <Input id="su-size" type="number" inputMode="decimal" min={0} step="0.1" className="h-11" value={v.size_cuft} onChange={(e) => setV({ ...v, size_cuft: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="su-notes">Notes</Label>
            <textarea
              id="su-notes"
              rows={2}
              value={v.notes}
              onChange={(e) => setV({ ...v, notes: e.target.value })}
              className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder="Condition, padlock, position in the yard…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            {row ? "Save" : "Add unit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------------------------------------------- lets */

function LetDialog({
  unit,
  clients,
  rates,
  onClose,
}: {
  unit: UnitRow;
  clients: PickerClient[];
  rates: StorageRates;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  // Product defaults from the Settings rate card — crates bill a day rate with
  // a 28-day minimum upfront; containers bill the monthly card rate in advance.
  const defaults = useMemo(() => letDefaultsForUnitType(unit.unit_type, rates), [unit.unit_type, rates]);
  const isCrate = defaults.billingModel === "crate_daily";
  const [v, setV] = useState({
    start_date: todayIso(),
    rate: defaults.rate != null ? String(defaults.rate) : "",
    rate_period: defaults.ratePeriod as "week" | "month" | "day",
    notes: "",
  });
  const [handlingIn, setHandlingIn] = useState(isCrate);
  const [handlingAmount, setHandlingAmount] = useState(String(rates.handlingEventInc));

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const pool = needle
      ? clients.filter((c) => [c.name, c.phone ?? "", c.email ?? ""].join(" ").toLowerCase().includes(needle))
      : clients;
    return pool.slice(0, 8);
  }, [clients, search]);

  const chosen = clients.find((c) => c.id === clientId) ?? null;

  async function save() {
    if (!clientId) {
      toast.error("Pick a client first.");
      return;
    }
    setBusy(true);
    const res = await startLetAction({
      unit_id: unit.id,
      client_id: clientId,
      start_date: v.start_date,
      rate: v.rate === "" ? "" : Number(v.rate),
      rate_period: v.rate_period,
      billing_model: defaults.billingModel,
      min_days: isCrate ? rates.crateMinDays : "",
      min_amount: isCrate ? rates.crateMinInc : "",
      record_handling_in: isCrate && handlingIn,
      handling_amount: handlingAmount === "" ? "" : Number(handlingAmount),
      notes: v.notes,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (res.warning) toast.warning(res.warning);
    toast.success("Unit assigned.");
    onClose();
    router.refresh();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Assign {unit.code || unit.name || "unit"}</DialogTitle>
          <DialogDescription>
            {isCrate
              ? `Crate storage: ${rates.crateMinDays}-day minimum (${gbp(rates.crateMinInc)}) invoiced upfront, then charged to the exact day in arrears. Handling bills per event.`
              : "Billed in advance each period; the invoice raises automatically each morning."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="sl-client">Client</Label>
            {chosen ? (
              <div className="flex items-center justify-between rounded-md border border-mm-red bg-mm-red-tint/40 px-3 py-2">
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium text-foreground">{chosen.name}</p>
                  <p className="truncate text-xs text-mist-500">{[chosen.phone, chosen.email].filter(Boolean).join(" · ") || "no contact"}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setClientId(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <>
                <Input
                  id="sl-client"
                  className="h-11"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, phone or email…"
                  autoFocus
                />
                <div className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {matches.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-mist-400">
                      No matching client. Add them on the Clients page first.
                    </p>
                  ) : (
                    matches.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setClientId(c.id)}
                        className="focus-ring flex w-full items-center justify-between px-3 py-2.5 text-left hover:bg-muted"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">{c.name}</span>
                          <span className="block truncate text-xs text-mist-500">
                            {[c.phone, c.email].filter(Boolean).join(" · ") || "no contact"}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sl-start">Start date</Label>
              <Input id="sl-start" type="date" className="h-11" value={v.start_date} onChange={(e) => setV({ ...v, start_date: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sl-rate">Rate (£)</Label>
              <Input id="sl-rate" type="number" inputMode="decimal" min={0} step="0.01" className="h-11" value={v.rate} onChange={(e) => setV({ ...v, rate: e.target.value })} placeholder="e.g. 25" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sl-period">Per</Label>
              {isCrate ? (
                <div className="flex h-11 items-center rounded-md border border-input bg-muted/60 px-3 text-sm text-mist-500">
                  Day (crate)
                </div>
              ) : (
                <Select value={v.rate_period} onValueChange={(val) => setV({ ...v, rate_period: val as "week" | "month" })}>
                  <SelectTrigger id="sl-period" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="week">Week</SelectItem>
                    <SelectItem value="month">Month</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {isCrate ? (
            <div className="rounded-md border border-input bg-muted/40 p-3">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={handlingIn}
                  onChange={(e) => setHandlingIn(e.target.checked)}
                  className="size-5 shrink-0 accent-mm-red"
                />
                <span className="text-sm text-foreground">Record handling in (bills on the first invoice)</span>
              </label>
              {handlingIn ? (
                <div className="mt-2 grid gap-1.5">
                  <Label htmlFor="sl-handling">Handling charge (£, inc VAT)</Label>
                  <Input
                    id="sl-handling"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    className="h-11"
                    value={handlingAmount}
                    onChange={(e) => setHandlingAmount(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="sl-notes">Notes</Label>
            <textarea
              id="sl-notes"
              rows={2}
              value={v.notes}
              onChange={(e) => setV({ ...v, notes: e.target.value })}
              className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              placeholder="Contents, insurance value, agreed terms…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !clientId} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Start let
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EndLetDialog({
  unit,
  let_,
  rates,
  onClose,
}: {
  unit: UnitRow;
  let_: LetRow;
  rates: StorageRates;
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [endDate, setEndDate] = useState(todayIso());
  const isCrate = let_.billing_model === "crate_daily";
  const [handlingOut, setHandlingOut] = useState(isCrate);
  const [handlingAmount, setHandlingAmount] = useState(String(rates.handlingEventInc));

  async function save() {
    setBusy(true);
    const res = await endLetAction(let_.id, endDate, {
      recordHandlingOut: isCrate && handlingOut,
      handlingAmount: handlingAmount === "" ? 0 : Number(handlingAmount),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (res.billingError) {
      toast.warning(`Let ended, but the settlement invoice failed (${res.billingError}) — the billing run retries tomorrow morning.`);
    } else if (res.raised?.length) {
      const total = res.raised.reduce((s, r) => s + r.amount, 0);
      toast.success(
        `Let ended — settlement raised: ${res.raised.map((r) => `${r.invoiceNumber} (${gbp(r.amount)})`).join(", ")}. ${gbp(total)} to settle before release.`,
      );
    } else {
      toast.success("Let ended — nothing further to bill; the unit is available again.");
    }
    onClose();
    router.refresh();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{isCrate ? "Release crate" : "End let"}</DialogTitle>
          <DialogDescription>
            {isCrate
              ? `${let_.client_name} is releasing ${unit.code || unit.name || "this crate"}. The final invoice — unbilled days to the release day plus handling out — is raised now, and everything is settled before the goods leave.`
              : `${let_.client_name} moves out of ${unit.code || unit.name || "this unit"} — it becomes available again. Billing stops automatically; periods already invoiced are not pro-rated, and any unpaid invoices stay collectable.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="el-date">{isCrate ? "Release date" : "End date"}</Label>
            <Input id="el-date" type="date" className="h-11" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          {isCrate ? (
            <div className="rounded-md border border-input bg-muted/40 p-3">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={handlingOut}
                  onChange={(e) => setHandlingOut(e.target.checked)}
                  className="size-5 shrink-0 accent-mm-red"
                />
                <span className="text-sm text-foreground">Charge handling out (on the final invoice)</span>
              </label>
              {handlingOut ? (
                <div className="mt-2 grid gap-1.5">
                  <Label htmlFor="el-handling">Handling charge (£, inc VAT)</Label>
                  <Input
                    id="el-handling"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    className="h-11"
                    value={handlingAmount}
                    onChange={(e) => setHandlingAmount(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            {isCrate ? "Release & raise final invoice" : "End let"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
