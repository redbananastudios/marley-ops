"use client";

/**
 * Leads triage board — turns the flat lead list into a "what needs me now" view.
 * - Each row is a triage unit: source colour dot, name, route, a response/urgency
 *   chip, value (when quoted) and status.
 * - Quick-filter preset chips with live counts (All / New / Uncontacted /
 *   Surveys due / Mine / This week) + search + status + All/Web source toggle.
 * - Smart default ordering: active & uncontacted first (longest-waiting on top),
 *   then active & contacted, then closed.
 * - Per-card actions in a footer: call, WhatsApp, mark-contacted, new quote — no
 *   need to open the lead to act.
 * Card grid: 3 per row on desktop, stacking to 1 on mobile.
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, Phone, PhoneMissed, MessageCircle, Check, Undo2, FileText, CalendarPlus, Loader2, Home, Clock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { noReplyForLeadAction } from "@/app/(dashboard)/follow-ups/actions";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LeadStatusBadge, LEAD_STATUSES, LEAD_STATUS_META } from "@/components/lead-status-badge";
import { Pager, usePager } from "@/components/ui/pager";
import { SOURCES, type SourceKey } from "@/lib/dashboard/compute";
import {
  markLeadContactedAction,
  markLeadUncontactedAction,
} from "@/app/(dashboard)/leads/actions";

export interface LeadCard {
  id: string;
  name: string | null;
  status: string;
  entry_channel: string;
  from_postcode: string | null;
  to_postcode: string | null;
  property_size: string | null;
  submitted_at: string | null;
  created_at: string | null;
  first_contacted_at: string | null;
  phone: string | null;
  email: string | null;
  estimator_id: string | null;
  source: SourceKey;
  value: number | null;
  surveyDue: boolean;
  /** Soonest upcoming survey appointment, if one is booked. */
  surveyAt: string | null;
  /** Open "no reply" retry (queued on Follow-ups), if any. */
  retry: { dueAt: string | null; attempts: number } | null;
}

type PresetKey = "all" | "new" | "uncontacted" | "retry" | "contacted" | "surveys" | "mine" | "week";
type SortKey = "recent" | "oldest" | "uncontacted" | "contacted";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Most recent" },
  { key: "oldest", label: "Oldest" },
  { key: "uncontacted", label: "Uncontacted first" },
  { key: "contacted", label: "Contacted first" },
];

const SOURCE_COLOR: Record<SourceKey, string> = Object.fromEntries(
  SOURCES.map((s) => [s.key, s.color]),
) as Record<SourceKey, string>;
const SOURCE_LABEL: Record<SourceKey, string> = Object.fromEntries(
  SOURCES.map((s) => [s.key, s.label]),
) as Record<SourceKey, string>;

const CLOSED = new Set(["completed", "declined"]);
const DAY = 86_400_000;

const tsOf = (l: LeadCard): number => new Date(l.submitted_at || l.created_at || 0).getTime();

const gbp = (n: number): string => "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** When the lead came in — e.g. "25 Jun 2026, 12:45". */
function fmtLeadDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ago(d: string | null): string {
  if (!d) return "";
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
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

/** Triage rank: active+uncontacted (0) → active+contacted (1) → closed (2). */
function rank(l: LeadCard): number {
  if (CLOSED.has(l.status)) return 2;
  return l.first_contacted_at ? 1 : 0;
}

export function LeadsBoard({
  leads,
  meId,
  initialStatus,
}: {
  leads: LeadCard[];
  meId: string | null;
  initialStatus?: string;
}) {
  const [tab, setTab] = useState<"all" | "web">("all");
  const [preset, setPreset] = useState<PresetKey>(initialStatus === "website_enquiry" ? "new" : "all");
  const [status, setStatus] = useState<string>(
    initialStatus && initialStatus !== "website_enquiry" ? initialStatus : "",
  );
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");

  const base = useMemo(
    () => (tab === "web" ? leads.filter((l) => l.entry_channel === "web") : leads),
    [leads, tab],
  );

  // Stable clock for the "this week" / age filters — lazy init keeps render pure.
  const [now] = useState(() => Date.now());
  const matchesPreset = (l: LeadCard, p: PresetKey): boolean => {
    switch (p) {
      case "new":
        return l.status === "website_enquiry";
      case "uncontacted":
        // "Awaiting retry" leads are actioned — they leave the Uncontacted bucket.
        return !CLOSED.has(l.status) && !l.first_contacted_at && !l.retry;
      case "retry":
        return !CLOSED.has(l.status) && !!l.retry;
      case "contacted":
        return !CLOSED.has(l.status) && !!l.first_contacted_at;
      case "surveys":
        return l.surveyDue;
      case "mine":
        return !!meId && l.estimator_id === meId;
      case "week":
        return tsOf(l) >= now - 7 * DAY;
      default:
        return true;
    }
  };

  const counts = useMemo(() => {
    const c: Record<PresetKey, number> = { all: base.length, new: 0, uncontacted: 0, retry: 0, contacted: 0, surveys: 0, mine: 0, week: 0 };
    for (const l of base) {
      if (matchesPreset(l, "new")) c.new++;
      if (matchesPreset(l, "uncontacted")) c.uncontacted++;
      if (matchesPreset(l, "retry")) c.retry++;
      if (matchesPreset(l, "contacted")) c.contacted++;
      if (matchesPreset(l, "surveys")) c.surveys++;
      if (matchesPreset(l, "mine")) c.mine++;
      if (matchesPreset(l, "week")) c.week++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, meId]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return base
      .filter((l) => matchesPreset(l, preset))
      .filter((l) => (status ? l.status === status : true))
      .filter((l) => {
        if (!term) return true;
        return [l.name, l.phone, l.email, l.from_postcode, l.to_postcode]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term));
      })
      .sort((a, b) => {
        // Contacted-axis sorts group by contact state first, then newest within.
        if (sort === "uncontacted" || sort === "contacted") {
          const want = sort === "uncontacted" ? 0 : 1; // 0 = uncontacted bucket
          const ga = rank(a) === want ? 0 : 1;
          const gb = rank(b) === want ? 0 : 1;
          if (ga !== gb) return ga - gb;
          return tsOf(b) - tsOf(a);
        }
        // Recency-axis sorts are pure date order.
        return sort === "oldest" ? tsOf(a) - tsOf(b) : tsOf(b) - tsOf(a);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, preset, status, search, sort]);

  const pager = usePager(visible, 24);

  const PRESETS: { key: PresetKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "new", label: "New" },
    { key: "uncontacted", label: "Uncontacted" },
    { key: "retry", label: "Awaiting retry" },
    { key: "contacted", label: "Contacted" },
    { key: "surveys", label: "Surveys due" },
    { key: "mine", label: "Mine" },
    { key: "week", label: "This week" },
  ];

  return (
    <div>
      {/* preset chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const active = preset === p.key;
          const count = counts[p.key];
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              aria-pressed={active}
              className={cn(
                "focus-ring inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "border-mm-red bg-mm-red-tint text-mm-red-deep"
                  : "border-border bg-card text-mist-500 hover:bg-muted",
              )}
            >
              {p.label}
              <span
                className={cn(
                  "tabular rounded-pill px-1.5 text-xs",
                  active ? "bg-mm-red/15 text-mm-red-deep" : "bg-muted text-mist-400",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
        <div className="ml-auto inline-flex rounded-md border border-border bg-muted/50 p-0.5">
          {(["all", "web"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "focus-ring rounded-[5px] px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                tab === t ? "bg-card text-foreground shadow-xs" : "text-mist-400 hover:text-foreground",
              )}
            >
              {t === "all" ? "All sources" : "Web"}
            </button>
          ))}
        </div>
      </div>

      {/* search + status */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, email, postcode"
            className="pl-9"
            aria-label="Search leads"
          />
        </div>
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="h-9 w-[160px]" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {LEAD_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {LEAD_STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="h-9 w-[180px]" aria-label="Sort leads">
            <span className="text-mist-400">Sort:&nbsp;</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="tabular text-xs text-mist-400">{visible.length} shown</span>
      </div>

      {/* card grid — 3 per row on desktop, paged so big datasets stay fast */}
      {visible.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border bg-card px-5 py-12 text-center text-sm text-mist-400">
          No leads match.
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pager.paged.map((l) => (
              <LeadCardItem key={l.id} lead={l} />
            ))}
          </div>
          <Pager
            page={pager.page}
            pages={pager.pages}
            total={pager.total}
            pageSize={pager.pageSize}
            onPage={pager.setPage}
            className="mt-4"
          />
        </>
      )}
    </div>
  );
}

/** "tomorrow 09:00" / "today 09:00" / "Mon 14 Jul, 09:00" for the retry chip. */
function fmtWhen(d: string | null): string {
  if (!d) return "soon";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "soon";
  const time = t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const startToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
  const diffDays = Math.floor((t.getTime() - startToday) / 86_400_000);
  if (diffDays === 0) return `today ${time}`;
  if (diffDays === 1) return `tomorrow ${time}`;
  return `${t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

function ResponseChip({ lead }: { lead: LeadCard }) {
  if (CLOSED.has(lead.status)) return null;
  if (lead.retry && !lead.first_contacted_at) {
    return (
      <span className="inline-flex items-center gap-1 rounded-pill bg-warn-bg px-2 py-0.5 text-xs font-medium text-warn">
        <PhoneMissed className="size-3 shrink-0" strokeWidth={2} />
        Retry {fmtWhen(lead.retry.dueAt)} · attempt {lead.retry.attempts}
      </span>
    );
  }
  if (lead.surveyAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-pill bg-[#eff6ff] px-2 py-0.5 text-xs font-medium text-[#2563eb]">
        <CalendarPlus className="size-3 shrink-0" strokeWidth={2} />
        Survey {fmtWhen(lead.surveyAt)}
      </span>
    );
  }
  if (lead.first_contacted_at) {
    return (
      <span className="inline-flex items-center gap-1 rounded-pill bg-muted px-2 py-0.5 text-xs text-mist-500">
        Contacted {ago(lead.first_contacted_at)} ago
      </span>
    );
  }
  const mins = Math.floor((Date.now() - tsOf(lead)) / 60000);
  const tone = mins > 240 ? "danger" : mins > 60 ? "warn" : "neutral";
  const cls =
    tone === "danger"
      ? "bg-danger-bg text-danger"
      : tone === "warn"
        ? "bg-warn-bg text-warn"
        : "bg-mm-red-tint text-mm-red-deep";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium", cls)}>
      {ago(lead.submitted_at || lead.created_at)} · not contacted
    </span>
  );
}

function LeadCardItem({ lead }: { lead: LeadCard }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const route =
    lead.from_postcode || lead.to_postcode
      ? `${lead.from_postcode ?? "?"} → ${lead.to_postcode ?? "?"}`
      : "no postcodes";
  const wa = waNumber(lead.phone);
  const active = !CLOSED.has(lead.status);
  const uncontacted = active && !lead.first_contacted_at;
  const contacted = active && !!lead.first_contacted_at;

  function markContacted() {
    start(async () => {
      const res = await markLeadContactedAction(lead.id);
      if (!res.ok) toast.error(res.error || "Could not mark contacted.");
      else {
        toast.success("Marked contacted.");
        router.refresh();
      }
    });
  }

  function markUncontacted() {
    start(async () => {
      const res = await markLeadUncontactedAction(lead.id);
      if (!res.ok) toast.error(res.error || "Could not revert.");
      else {
        toast.success("Back to uncontacted.");
        router.refresh();
      }
    });
  }

  function logNoReply() {
    start(async () => {
      const res = await noReplyForLeadAction(lead.id);
      if (!res.ok) toast.error(res.error || "Could not log the attempt.");
      else {
        toast.success("No-reply logged — follow-up queued for tomorrow.");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-shadow hover:shadow-sm">
      {/* card body — taps through to the lead */}
      <Link href={`/leads/${lead.id}`} className="flex flex-1 flex-col gap-3 p-4">
        {/* identity row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="mt-1 size-2.5 shrink-0 rounded-full"
              style={{ background: SOURCE_COLOR[lead.source] }}
              title={SOURCE_LABEL[lead.source]}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{lead.name ?? "—"}</p>
              <p className="truncate text-xs text-mist-400">{SOURCE_LABEL[lead.source]}</p>
            </div>
          </div>
          <LeadStatusBadge status={lead.status} />
        </div>

        {/* route + value */}
        <div className="flex items-center justify-between gap-3">
          <span className="tabular min-w-0 truncate text-sm text-foreground">{route}</span>
          {lead.value != null ? (
            <span className="tabular shrink-0 text-sm font-semibold text-foreground">{gbp(lead.value)}</span>
          ) : null}
        </div>

        {/* contact line */}
        <p className="truncate text-xs text-mist-400">
          {[lead.phone, lead.email].filter(Boolean).join(" · ") || "no contact details"}
        </p>

        {/* move type + lead date */}
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          {lead.property_size ? (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-pill bg-[#ecfdf5] px-2 py-0.5 text-xs font-medium text-[#16a34a]">
              <Home className="size-3 shrink-0" strokeWidth={2} />
              <span className="truncate">{lead.property_size}</span>
            </span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-pill bg-muted px-2 py-0.5 text-xs text-mist-400">
              <Home className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="truncate">Size not given</span>
            </span>
          )}
          <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-[#eff6ff] px-2 py-0.5 text-xs font-medium tabular text-[#2563eb]">
            <Clock className="size-3 shrink-0" strokeWidth={2} />
            {fmtLeadDate(lead.submitted_at || lead.created_at)}
          </span>
        </div>

        {/* response / urgency chip */}
        <div className="mt-auto pt-1">
          <ResponseChip lead={lead} />
        </div>
      </Link>

      {/* actions — below the card */}
      <div className="flex items-center gap-0.5 border-t border-border bg-muted/30 px-2.5 py-2">
        {lead.phone ? (
          <a
            href={`tel:${lead.phone}`}
            title="Call"
            aria-label="Call"
            className="focus-ring flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-mist-500 hover:bg-muted hover:text-foreground"
          >
            <Phone className="size-4" strokeWidth={1.75} />
            Call
          </a>
        ) : null}
        {wa ? (
          <a
            href={`https://wa.me/${wa}`}
            target="_blank"
            rel="noopener noreferrer"
            title="WhatsApp"
            aria-label="WhatsApp"
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-500 hover:bg-muted hover:text-foreground"
          >
            <MessageCircle className="size-4" strokeWidth={1.75} />
          </a>
        ) : null}
        {uncontacted ? (
          <button
            type="button"
            onClick={markContacted}
            disabled={pending}
            title="Mark contacted"
            aria-label="Mark contacted"
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-success disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Check className="size-4" strokeWidth={1.75} />}
          </button>
        ) : null}
        {contacted ? (
          <button
            type="button"
            onClick={markUncontacted}
            disabled={pending}
            title="Mark uncontacted (undo)"
            aria-label="Mark uncontacted"
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Undo2 className="size-4" strokeWidth={1.75} />}
          </button>
        ) : null}
        {active ? (
          <button
            type="button"
            onClick={logNoReply}
            disabled={pending}
            title="No reply — retry tomorrow"
            aria-label="No reply"
            className="focus-ring flex size-9 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-danger disabled:opacity-50"
          >
            <PhoneMissed className="size-4" strokeWidth={1.75} />
          </button>
        ) : null}
        {active ? (
          <Link
            href={`/schedule/surveys?leadId=${lead.id}`}
            title="Book survey"
            aria-label="Book survey"
            className="focus-ring flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-mist-500 hover:bg-muted hover:text-foreground"
          >
            <CalendarPlus className="size-4" strokeWidth={1.75} />
            Survey
          </Link>
        ) : null}
        <Link
          href={`/quotes/new?leadId=${lead.id}`}
          prefetch={false}
          title="New quote"
          aria-label="New quote"
          className="focus-ring flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-mist-500 hover:bg-muted hover:text-foreground"
        >
          <FileText className="size-4" strokeWidth={1.75} />
          Quote
        </Link>
      </div>
    </div>
  );
}
