"use client";

/**
 * Status board — a colour-coded, data-rich kanban of the lead funnel.
 * Each stage has its own colour (column header + card left-stripe); cards carry
 * name, route, move date, property size, value and an urgency chip, with quick
 * actions (WhatsApp / Call / New quote) and drag-or-tap to move between stages.
 * Column headers show count + total £ value in that stage. Light filters
 * (search / source / Mine / hide-declined) keep it focused. iPad-first.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoveHorizontal, FileText, Search, Calendar, Home, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { LEAD_STATUSES, LEAD_STATUS_META } from "@/components/lead-status-badge";
import { updateLeadStatusAction } from "@/app/(dashboard)/leads/actions";
import { SOURCES, type SourceKey } from "@/lib/dashboard/compute";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ContactAction } from "@/components/ui/contact-action";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface BoardLead {
  id: string;
  name: string | null;
  status: string;
  source: SourceKey;
  from_postcode: string | null;
  to_postcode: string | null;
  preferred_date: string | null;
  property_size: string | null;
  first_contacted_at: string | null;
  phone: string | null;
  estimator_id: string | null;
  submitted_at: string | null;
  created_at: string | null;
  value: number | null;
}

const STATUSES = LEAD_STATUSES as string[];

/** Per-stage colour identity (column header + card stripe). */
const STATUS_COLOR: Record<string, string> = {
  website_enquiry: "#71717a",
  survey_booked: "#C0822E",
  quoted: "#2F7E96",
  provisional: "#7C5CBF",
  confirmed: "#c03838",
  completed: "#3F9B6B",
  declined: "#a1a1aa",
};

const SOURCE_COLOR: Record<SourceKey, string> = Object.fromEntries(SOURCES.map((s) => [s.key, s.color])) as Record<
  SourceKey,
  string
>;
const SOURCE_LABEL: Record<SourceKey, string> = Object.fromEntries(SOURCES.map((s) => [s.key, s.label])) as Record<
  SourceKey,
  string
>;

const CLOSED = new Set(["completed", "declined"]);

const gbp = (n: number): string => "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function dateShort(d: string | null): string | null {
  if (!d) return null;
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function ago(d: string | null): string {
  if (!d) return "";
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 60) return `${Math.max(0, mins)}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function waNumber(phone: string | null): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("0")) d = "44" + d.slice(1);
  return d.length >= 10 ? d : null;
}

function routeLine(l: BoardLead): string {
  const f = l.from_postcode?.trim();
  const t = l.to_postcode?.trim();
  if (f && t) return `${f} → ${t}`;
  if (f) return `from ${f}`;
  if (t) return `to ${t}`;
  return "no postcodes";
}

/** yyyy-mm-dd ± n days (UTC-safe — the strings are pure dates). */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Mon 6 – Sun 12 Jul 2026" style label for a Monday-start week. */
function weekLabel(start: string): string {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${addDays(start, 6)}T00:00:00Z`);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  const sameMonth = s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
  const from = sameMonth ? String(s.getUTCDate()) : s.toLocaleDateString("en-GB", opts);
  const to = e.toLocaleDateString("en-GB", { ...opts, year: "numeric" });
  return `${from} – ${to}`;
}

type WeekBasis = "enquiry" | "move";

export function StatusBoard({
  leads: initialLeads,
  meId,
  thisWeekStart,
}: {
  leads: BoardLead[];
  meId: string | null;
  thisWeekStart: string;
}) {
  const router = useRouter();
  const [leads, setLeads] = useState<BoardLead[]>(initialLeads);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [source, setSource] = useState<string>("");
  const [mine, setMine] = useState(false);
  const [showDeclined, setShowDeclined] = useState(false);
  const [mobileCol, setMobileCol] = useState<string>("website_enquiry");
  // Default view: the current Mon–Sun week (null = all time).
  const [weekStart, setWeekStart] = useState<string | null>(thisWeekStart);
  const [basis, setBasis] = useState<WeekBasis>("enquiry");

  const columns = useMemo(
    () => [...STATUSES.filter((s) => s !== "declined"), ...(showDeclined ? ["declined"] : [])],
    [showDeclined],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const weekEnd = weekStart ? addDays(weekStart, 6) : null;
    return leads.filter((l) => {
      if (weekStart && weekEnd) {
        // "enquiry" = when the lead came in; "move" = the preferred move date.
        const day =
          basis === "move"
            ? (l.preferred_date?.slice(0, 10) ?? null)
            : l.submitted_at || l.created_at
              ? new Date(l.submitted_at ?? l.created_at ?? 0).toLocaleDateString("en-CA", { timeZone: "Europe/London" })
              : null;
        if (!day || day < weekStart || day > weekEnd) return false;
      }
      if (source && l.source !== source) return false;
      if (mine && l.estimator_id !== meId) return false;
      if (term) {
        const hay = [l.name, l.from_postcode, l.to_postcode, l.phone].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [leads, search, source, mine, meId, weekStart, basis]);

  async function move(leadId: string, toStatus: string) {
    const current = leads.find((l) => l.id === leadId);
    if (!current || current.status === toStatus) return;
    const fromStatus = current.status;
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: toStatus } : l)));
    const res = await updateLeadStatusAction(leadId, toStatus);
    if (res.ok) {
      toast.success(`Moved to ${LEAD_STATUS_META[toStatus]?.label ?? toStatus}`);
      router.refresh();
    } else {
      setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: fromStatus } : l)));
      toast.error(res.error ?? "Could not move lead");
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* week navigator — Mon–Sun window, arrows step a week at a time */}
        <div className="inline-flex items-stretch overflow-hidden rounded-md border border-input bg-card">
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w ?? thisWeekStart, -7))}
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
            {weekStart ? weekLabel(weekStart) : "All time"}
          </button>
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w ?? thisWeekStart, 7))}
            aria-label="Next week"
            className="focus-ring flex min-h-9 w-9 items-center justify-center text-mist-400 transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <Select value={basis} onValueChange={(v) => setBasis(v as WeekBasis)}>
          <SelectTrigger className="h-9 w-[132px]" aria-label="Week filters by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="enquiry">Enquiry week</SelectItem>
            <SelectItem value="move">Move week</SelectItem>
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={() => setWeekStart((w) => (w ? null : thisWeekStart))}
          aria-pressed={weekStart === null}
          className={cn(
            "focus-ring inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors",
            weekStart === null
              ? "border-mm-red bg-mm-red-tint text-mm-red-deep"
              : "border-input bg-card text-mist-500 hover:bg-muted",
          )}
        >
          All
        </button>

        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, postcode, phone"
            className="pl-9"
            aria-label="Search board"
          />
        </div>
        <Select value={source || "all"} onValueChange={(v) => setSource(v === "all" ? "" : v)}>
          <SelectTrigger className="h-9 w-[150px]" aria-label="Filter by source">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {SOURCES.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={() => setMine((m) => !m)}
          aria-pressed={mine}
          className={cn(
            "focus-ring inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors",
            mine ? "border-mm-red bg-mm-red-tint text-mm-red-deep" : "border-input bg-card text-mist-500 hover:bg-muted",
          )}
        >
          Mine
        </button>
        <button
          type="button"
          onClick={() => setShowDeclined((d) => !d)}
          aria-pressed={showDeclined}
          className={cn(
            "focus-ring inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors",
            showDeclined ? "border-mm-red bg-mm-red-tint text-mm-red-deep" : "border-input bg-card text-mist-500 hover:bg-muted",
          )}
        >
          {showDeclined ? "Hide declined" : "Show declined"}
        </button>
      </div>

      {/* mobile stage selector — pick a column to view full-width */}
      <div className="-mx-6 mb-3 flex gap-1.5 overflow-x-auto px-6 pb-1 lg:hidden">
        {columns.map((status) => {
          const color = STATUS_COLOR[status] ?? "#71717a";
          const count = filtered.filter((l) => l.status === status).length;
          const active = mobileCol === status;
          return (
            <button
              key={status}
              type="button"
              onClick={() => setMobileCol(status)}
              aria-pressed={active}
              className={cn(
                "focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 py-1.5 text-sm font-medium transition-colors",
                active ? "border-mm-red bg-mm-red-tint text-mm-red-deep" : "border-border bg-card text-mist-500",
              )}
            >
              <span className="size-2 rounded-full" style={{ background: color }} />
              {LEAD_STATUS_META[status]?.label ?? status}
              <span className="tabular text-xs opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {/* columns */}
      <div className="-mx-6 flex-1 overflow-x-auto px-6 pb-2 md:-mx-8 md:px-8">
        <div className="flex gap-4 lg:min-w-max">
          {columns.map((status) => {
            const meta = LEAD_STATUS_META[status];
            const color = STATUS_COLOR[status] ?? "#71717a";
            const columnLeads = filtered.filter((l) => l.status === status);
            const total = columnLeads.reduce((sum, l) => sum + (l.value ?? 0), 0);
            const isTarget = dropTarget === status;

            return (
              <section
                key={status}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dropTarget !== status) setDropTarget(status);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDropTarget((t) => (t === status ? null : t));
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const leadId = e.dataTransfer.getData("text/plain") || draggingId;
                  setDropTarget(null);
                  setDraggingId(null);
                  if (leadId) void move(leadId, status);
                }}
                className={cn(
                  "flex w-full flex-col overflow-hidden rounded-lg border bg-muted/30 transition-colors lg:w-72 lg:shrink-0",
                  status !== mobileCol && "hidden lg:flex",
                  isTarget && "border-dashed border-mm-red bg-accent",
                )}
              >
                <header className="border-t-[3px] bg-card" style={{ borderTopColor: color }}>
                  <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                    <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <span className="size-2.5 rounded-full" style={{ background: color }} />
                      {meta?.label ?? status}
                    </span>
                    <span className="inline-flex min-w-6 items-center justify-center rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
                      {columnLeads.length}
                    </span>
                  </div>
                  {total > 0 ? (
                    <div className="border-t px-3 py-1.5">
                      <span className="tabular text-xs font-medium text-mist-500">{gbp(total)}</span>
                    </div>
                  ) : null}
                </header>

                <div className="flex flex-1 flex-col gap-2 p-2">
                  {columnLeads.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-mist-400">No leads.</p>
                  ) : (
                    columnLeads.map((lead) => (
                      <Card key={lead.id} lead={lead} color={color} draggingId={draggingId} setDraggingId={setDraggingId} setDropTarget={setDropTarget} columns={columns} move={move} />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Card({
  lead,
  color,
  draggingId,
  setDraggingId,
  setDropTarget,
  columns,
  move,
}: {
  lead: BoardLead;
  color: string;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  setDropTarget: (s: string | null) => void;
  columns: string[];
  move: (id: string, to: string) => void;
}) {
  // Stable clock for the "not contacted" age chip — lazy init keeps render pure.
  const [now] = useState(() => Date.now());
  const wa = waNumber(lead.phone);
  const md = dateShort(lead.preferred_date);
  const uncontacted = !CLOSED.has(lead.status) && !lead.first_contacted_at;
  const urgency = uncontacted
    ? (() => {
        const mins = Math.floor((now - new Date(lead.submitted_at || lead.created_at || 0).getTime()) / 60000);
        const tone = mins > 240 ? "bg-danger-bg text-danger" : mins > 60 ? "bg-warn-bg text-warn" : "bg-mm-red-tint text-mm-red-deep";
        return { tone, text: `${ago(lead.submitted_at || lead.created_at)} · not contacted` };
      })()
    : null;

  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", lead.id);
        e.dataTransfer.effectAllowed = "move";
        setDraggingId(lead.id);
      }}
      onDragEnd={() => {
        setDraggingId(null);
        setDropTarget(null);
      }}
      style={{ borderLeftColor: color }}
      className={cn(
        "group cursor-grab rounded-md border border-l-[3px] bg-card p-2.5 active:cursor-grabbing",
        draggingId === lead.id && "opacity-50",
      )}
    >
      <Link href={`/leads/${lead.id}`} className="block">
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-full" style={{ background: SOURCE_COLOR[lead.source] }} title={SOURCE_LABEL[lead.source]} />
            <span className="truncate text-sm font-semibold text-foreground">{lead.name ?? "—"}</span>
          </span>
          {lead.value != null ? (
            <span className="tabular shrink-0 text-sm font-semibold text-foreground">{gbp(lead.value)}</span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-mist-400">{routeLine(lead)}</p>
        {md || lead.property_size ? (
          <p className="mt-1 flex items-center gap-2 text-xs text-mist-500">
            {md ? (
              <span className="inline-flex items-center gap-1">
                <Calendar className="size-3" strokeWidth={1.75} />
                {md}
              </span>
            ) : null}
            {lead.property_size ? (
              <span className="inline-flex items-center gap-1">
                <Home className="size-3" strokeWidth={1.75} />
                {lead.property_size}
              </span>
            ) : null}
          </p>
        ) : null}
        {urgency ? (
          <span className={cn("mt-1.5 inline-flex items-center rounded-pill px-1.5 py-0.5 text-[11px] font-medium", urgency.tone)}>
            {urgency.text}
          </span>
        ) : null}
      </Link>

      {/* quick actions */}
      <div className="mt-2 flex items-center gap-0.5 border-t pt-1.5">
        {lead.phone ? <ContactAction kind="call" href={`tel:${lead.phone}`} className="size-8" /> : null}
        {wa ? <ContactAction kind="whatsapp" href={`https://wa.me/${wa}`} className="size-8" /> : null}
        <Link href={`/quotes/new?leadId=${lead.id}`} prefetch={false} title="New quote" aria-label="New quote" className="focus-ring flex size-8 items-center justify-center rounded-md text-mist-500 transition-colors hover:bg-muted hover:text-foreground">
          <FileText className="size-4" strokeWidth={1.75} />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Move lead"
            className="focus-ring ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground"
          >
            <MoveHorizontal strokeWidth={1.75} className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {columns
              .concat(columns.includes("declined") ? [] : ["declined"])
              .filter((s) => s !== lead.status)
              .map((s) => (
                <DropdownMenuItem key={s} onSelect={() => void move(lead.id, s)}>
                  <span className="mr-2 size-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />
                  {LEAD_STATUS_META[s]?.label ?? s}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
