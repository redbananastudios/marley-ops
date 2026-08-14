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
import {
  Search,
  Phone,
  PhoneMissed,
  MessageCircle,
  Check,
  Undo2,
  FileText,
  CalendarPlus,
  Loader2,
  Home,
  Clock,
  MoreHorizontal,
  ExternalLink,
  LayoutGrid,
  Rows3,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LEAD_STATUSES, LEAD_STATUS_META } from "@/components/lead-status-badge";
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
  /** Accepted quote reference, otherwise the latest quote reference. */
  reference: string | null;
  surveyDue: boolean;
  /** Soonest upcoming survey appointment, if one is booked. */
  surveyAt: string | null;
  /** Open "no reply" retry (queued on Follow-ups), if any. */
  retry: { dueAt: string | null; attempts: number } | null;
}

type PresetKey = "all" | "new" | "uncontacted" | "retry" | "contacted" | "surveys" | "mine" | "week";
type SortKey = "recent" | "oldest" | "uncontacted" | "contacted";
type ViewMode = "board" | "table";

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

const BOARD_STATUS_STYLE: Record<string, { border: string; badge: string }> = {
  website_enquiry: { border: "#E58A19", badge: "bg-[#FFF4E5] text-[#B56300]" },
  survey_booked: { border: "#8B5CF6", badge: "bg-[#F2ECFF] text-[#6D3DD1]" },
  quoted: { border: "#27A862", badge: "bg-[#EAF8F0] text-[#187944]" },
  provisional: { border: "#2F80ED", badge: "bg-[#EAF3FF] text-[#1D5FBF]" },
  confirmed: { border: "#C03838", badge: "bg-[#FBECEC] text-[#A8221C]" },
  completed: { border: "#27A862", badge: "bg-[#EAF8F0] text-[#187944]" },
  declined: { border: "#697386", badge: "bg-[#F1F3F5] text-[#475467]" },
};

const FALLBACK_STATUS_STYLE = { border: "#697386", badge: "bg-[#F1F3F5] text-[#475467]" };

function BoardStatusBadge({ status }: { status: string }) {
  const style = BOARD_STATUS_STYLE[status] ?? FALLBACK_STATUS_STYLE;
  const label = LEAD_STATUS_META[status]?.label ?? status.replaceAll("_", " ");
  return (
    <span className={cn("inline-flex shrink-0 rounded-[5px] px-2 py-1 text-[10px] font-bold leading-none uppercase", style.badge)}>
      {label}
    </span>
  );
}

const tsOf = (l: LeadCard): number => new Date(l.submitted_at || l.created_at || 0).getTime();

const gbp = (n: number): string => "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** When the lead came in — compact enough to scan inside the card. */
function fmtLeadDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  // 2-digit year so a closed lead's "Received" date stays unambiguous once the
  // data spans years — "25 Jun 26, 12:45".
  return t.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "2-digit",
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
  // No URL status → default to the "Enquiry" preset (Peter, 2026-08-14): the
  // page opens on what needs actioning, not the full history. An explicit
  // ?status= link (dashboard cards, saved filters) still lands as before.
  const [preset, setPreset] = useState<PresetKey>(
    initialStatus && initialStatus !== "website_enquiry" ? "all" : "new",
  );
  const [status, setStatus] = useState<string>(
    initialStatus && initialStatus !== "website_enquiry" ? initialStatus : "",
  );
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [view, setView] = useState<ViewMode>("board");

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
                "focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                active
                  ? "border-[#E7A7A7] bg-[#FBECEC] text-[#A8221C]"
                  : "border-[#E2E6EC] bg-white text-[#667085] hover:border-[#C8CED8] hover:bg-[#F7F8FA] hover:text-[#344054]",
              )}
            >
              {p.label}
              <span
                className={cn(
                  "tabular rounded-full px-1.5 text-xs",
                  active ? "bg-white/70 text-[#A8221C]" : "bg-[#F1F3F5] text-[#667085]",
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
        <div role="group" className="ml-auto inline-flex rounded-md border border-[#E2E6EC] bg-[#F1F3F5] p-0.5" aria-label="Lead view">
          <button
            type="button"
            onClick={() => setView("board")}
            aria-pressed={view === "board"}
            className={cn(
              "focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-semibold transition-colors",
              view === "board" ? "bg-white text-[#172033] shadow-xs" : "text-[#667085] hover:text-[#172033]",
            )}
          >
            <LayoutGrid className="size-3.5" aria-hidden />
            Board
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            aria-pressed={view === "table"}
            className={cn(
              "focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-semibold transition-colors",
              view === "table" ? "bg-white text-[#172033] shadow-xs" : "text-[#667085] hover:text-[#172033]",
            )}
          >
            <Rows3 className="size-3.5" aria-hidden />
            Table
          </button>
        </div>
      </div>

      {/* card grid — 3 per row on desktop, paged so big datasets stay fast */}
      {visible.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border bg-card px-5 py-12 text-center text-sm text-mist-400">
          No leads match.
        </div>
      ) : (
        <>
          {view === "board" ? (
            <div data-testid="leads-board" className="mt-3 grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pager.paged.map((l) => (
                <LeadCardItem key={l.id} lead={l} />
              ))}
            </div>
          ) : (
            <LeadTable leads={pager.paged} />
          )}
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

/**
 * Per-lead overflow menu — Open / WhatsApp / mark-(un)contacted / no-reply.
 * Shared by the Board cards AND the Table rows so neither view loses the
 * one-click contact-state actions.
 */
function LeadActionsMenu({ lead, className }: { lead: LeadCard; className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More actions for ${lead.name ?? "lead"}`}
          className={cn(
            "focus-ring flex size-8 shrink-0 items-center justify-center rounded-md text-[#667085] hover:bg-[#F1F3F5] hover:text-[#172033]",
            className,
          )}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-5" strokeWidth={1.75} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem asChild>
          <Link href={`/leads/${lead.id}`}>
            <ExternalLink />
            Open lead
          </Link>
        </DropdownMenuItem>
        {wa ? (
          <DropdownMenuItem asChild>
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer">
              <MessageCircle />
              WhatsApp
            </a>
          </DropdownMenuItem>
        ) : null}
        {(uncontacted || contacted || active) ? <DropdownMenuSeparator /> : null}
        {uncontacted ? (
          <DropdownMenuItem onSelect={markContacted} disabled={pending}>
            <Check />
            Mark contacted
          </DropdownMenuItem>
        ) : null}
        {contacted ? (
          <DropdownMenuItem onSelect={markUncontacted} disabled={pending}>
            <Undo2 />
            Mark uncontacted
          </DropdownMenuItem>
        ) : null}
        {active ? (
          <DropdownMenuItem onSelect={logNoReply} disabled={pending}>
            <PhoneMissed />
            No reply — retry tomorrow
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LeadTable({ leads }: { leads: LeadCard[] }) {
  return (
    <div data-testid="leads-table" className="mt-3 overflow-x-auto rounded-[10px] border border-[#E2E6EC] bg-white">
      <table className="w-full min-w-[920px] border-collapse text-left">
        <thead className="bg-[#F7F8FA] text-[11px] font-bold uppercase tracking-[0.04em] text-[#667085]">
          <tr>
            <th scope="col" className="px-4 py-2.5">Customer</th>
            <th scope="col" className="px-4 py-2.5">Move</th>
            <th scope="col" className="px-4 py-2.5">Status</th>
            <th scope="col" className="px-4 py-2.5">Quote</th>
            <th scope="col" className="px-4 py-2.5">Next action</th>
            <th scope="col" className="px-4 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E2E6EC]">
          {leads.map((lead) => {
            const active = !CLOSED.has(lead.status);
            const route =
              lead.from_postcode || lead.to_postcode
                ? `${lead.from_postcode ?? "?"} → ${lead.to_postcode ?? "?"}`
                : "No postcodes";
            return (
              <tr key={lead.id} className="hover:bg-[#F7F8FA]">
                <td className="px-4 py-3 align-middle">
                  <Link href={`/leads/${lead.id}`} className="focus-ring rounded-sm text-sm font-bold text-[#172033] hover:text-[#A8221C]">
                    {lead.name ?? "—"}
                  </Link>
                  <p className="mt-0.5 max-w-48 truncate text-[11px] text-[#667085]">
                    {SOURCE_LABEL[lead.source]}
                    {lead.reference ? ` · ${lead.reference}` : ""}
                  </p>
                </td>
                <td className="px-4 py-3 align-middle">
                  <p className="text-[13px] font-semibold text-[#344054]">{route}</p>
                  {lead.property_size ? <p className="mt-0.5 text-[11px] text-[#667085]">{lead.property_size}</p> : null}
                </td>
                <td className="px-4 py-3 align-middle"><BoardStatusBadge status={lead.status} /></td>
                <td className="px-4 py-3 align-middle">
                  {lead.value != null ? (
                    <span className="tabular font-bold text-[#C03838]">{gbp(lead.value)}</span>
                  ) : (
                    <span className="text-[#98A2B3]">—</span>
                  )}
                </td>
                <td className="px-4 py-3 align-middle">
                  <ResponseChip lead={lead} />
                  {CLOSED.has(lead.status) ? (
                    <span className="text-xs text-[#667085]">Received {fmtLeadDate(lead.submitted_at || lead.created_at)}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3 align-middle">
                  <div className="flex items-center justify-end gap-1">
                    {lead.phone ? (
                      <a href={`tel:${lead.phone}`} aria-label={`Call ${lead.name ?? "lead"}`} className="focus-ring rounded-md p-2 text-[#667085] hover:bg-white hover:text-[#172033]">
                        <Phone className="size-4" aria-hidden />
                      </a>
                    ) : null}
                    {active ? (
                      <Link href={`/schedule/surveys?leadId=${lead.id}`} aria-label={`Book survey for ${lead.name ?? "lead"}`} className="focus-ring rounded-md p-2 text-[#667085] hover:bg-white hover:text-[#172033]">
                        <CalendarPlus className="size-4" aria-hidden />
                      </Link>
                    ) : null}
                    <Link href={`/quotes/new?leadId=${lead.id}`} prefetch={false} aria-label={`New quote for ${lead.name ?? "lead"}`} className="focus-ring rounded-md p-2 text-[#667085] hover:bg-white hover:text-[#172033]">
                      <FileText className="size-4" aria-hidden />
                    </Link>
                    <Link href={`/leads/${lead.id}`} aria-label={`Open ${lead.name ?? "lead"}`} className="focus-ring rounded-md p-2 text-[#667085] hover:bg-white hover:text-[#172033]">
                      <ExternalLink className="size-4" aria-hidden />
                    </Link>
                    <LeadActionsMenu lead={lead} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
      <span className="inline-flex items-center gap-1 rounded-[5px] border border-[#F1CACA] bg-[#FBECEC] px-2 py-1 text-[11px] font-semibold leading-none text-[#A8221C]">
        <PhoneMissed className="size-3 shrink-0" strokeWidth={2} />
        Retry {fmtWhen(lead.retry.dueAt)} · attempt {lead.retry.attempts}
      </span>
    );
  }
  if (lead.surveyAt) {
    return (
      <span className="inline-flex items-center gap-1 rounded-[5px] bg-[#EAF3FF] px-2 py-1 text-[11px] font-semibold leading-none text-[#1D5FBF]">
        <CalendarPlus className="size-3 shrink-0" strokeWidth={2} />
        Survey {fmtWhen(lead.surveyAt)}
      </span>
    );
  }
  if (lead.first_contacted_at) {
    return (
      <span className="inline-flex items-center gap-1 rounded-[5px] bg-[#F1F3F5] px-2 py-1 text-[11px] font-medium leading-none text-[#667085]">
        <Check className="size-3 shrink-0" strokeWidth={2} />
        Contacted {ago(lead.first_contacted_at)} ago
      </span>
    );
  }
  const age = ago(lead.submitted_at || lead.created_at);
  return (
    <span className="inline-flex items-center gap-1 rounded-[5px] border border-[#F1CACA] bg-[#FBECEC] px-2 py-1 text-[11px] font-semibold leading-none text-[#A8221C]">
      <Clock className="size-3 shrink-0" strokeWidth={2} />
      Not contacted{age ? ` · ${age}` : ""}
    </span>
  );
}

function LeadCardItem({ lead }: { lead: LeadCard }) {
  const route =
    lead.from_postcode || lead.to_postcode
      ? `${lead.from_postcode ?? "?"} → ${lead.to_postcode ?? "?"}`
      : "no postcodes";
  const active = !CLOSED.has(lead.status);
  const statusStyle = BOARD_STATUS_STYLE[lead.status] ?? FALLBACK_STATUS_STYLE;

  return (
    <article
      style={{ borderTopColor: statusStyle.border }}
      className="group flex h-full flex-col overflow-hidden rounded-[10px] border border-t-4 border-[#E2E6EC] bg-white shadow-[0_2px_5px_rgba(16,24,40,0.05)] transition-[transform,border-color,box-shadow] duration-150 motion-safe:hover:-translate-y-px hover:border-[#C8CED8] hover:shadow-[0_5px_12px_rgba(16,24,40,0.09)]"
    >
      <div className="flex min-h-[122px] flex-1 flex-col px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              href={`/leads/${lead.id}`}
              className="focus-ring min-w-0 rounded-sm text-[15px] font-bold leading-5 text-[#172033] hover:text-[#A8221C]"
            >
              <span className="block truncate">{lead.name ?? "—"}</span>
            </Link>
            <BoardStatusBadge status={lead.status} />
          </div>

          <LeadActionsMenu lead={lead} className="-mt-1 -mr-1" />
        </div>

        <Link href={`/leads/${lead.id}`} className="focus-ring mt-1.5 flex flex-1 flex-col rounded-sm">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="tabular min-w-0 truncate text-[13px] font-semibold text-[#344054]">{route}</span>
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-[11px] text-[#667085]">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: SOURCE_COLOR[lead.source] }}
              />
              <span className="shrink-0">{SOURCE_LABEL[lead.source]}</span>
              {lead.reference ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate font-medium text-[#475467]">{lead.reference}</span>
                </>
              ) : null}
            </span>
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
            {lead.value != null ? (
              <span className="tabular inline-flex shrink-0 items-baseline gap-1 text-[21px] font-bold leading-none tracking-[-0.3px] text-[#C03838]">
                {gbp(lead.value)}
                <span className="text-[10px] font-semibold tracking-normal text-[#667085]">GBP</span>
              </span>
            ) : null}
            {lead.property_size ? (
              <span className="inline-flex min-w-0 items-center gap-1 rounded-[5px] bg-[#EAF8F0] px-2 py-1 text-[11px] font-semibold leading-none text-[#187944]">
                <Home className="size-3 shrink-0" strokeWidth={2} />
                <span className="truncate">{lead.property_size}</span>
              </span>
            ) : null}
            <ResponseChip lead={lead} />
            {!lead.surveyAt && !lead.retry && !lead.first_contacted_at && CLOSED.has(lead.status) ? (
              <span className="inline-flex items-center gap-1 rounded-[5px] bg-[#EAF3FF] px-2 py-1 text-[11px] font-semibold leading-none text-[#1D5FBF]">
                <Clock className="size-3 shrink-0" strokeWidth={2} />
                Received {fmtLeadDate(lead.submitted_at || lead.created_at)}
              </span>
            ) : null}
          </div>
        </Link>
      </div>

      <div className="grid min-h-11 grid-cols-3 divide-x divide-[#E2E6EC] border-t border-[#E2E6EC]">
        {lead.phone ? (
          <a
            href={`tel:${lead.phone}`}
            title={`Call ${lead.phone}`}
            aria-label={`Call ${lead.name ?? "lead"}`}
            className="focus-ring flex min-h-11 items-center justify-center gap-2 text-[13px] font-semibold text-[#344054] hover:bg-[#F7F8FA]"
          >
            <Phone className="size-4" strokeWidth={1.75} />
            Call
          </a>
        ) : (
          <button
            type="button"
            disabled
            title="No phone number on this lead"
            className="flex min-h-11 items-center justify-center gap-2 text-[13px] font-semibold text-[#98A2B3]"
          >
            <Phone className="size-4" strokeWidth={1.75} />
            Call
          </button>
        )}
        {active ? (
          <Link
            href={`/schedule/surveys?leadId=${lead.id}`}
            title="Book survey"
            aria-label={`Book survey for ${lead.name ?? "lead"}`}
            className="focus-ring flex min-h-11 items-center justify-center gap-2 text-[13px] font-semibold text-[#344054] hover:bg-[#F7F8FA]"
          >
            <CalendarPlus className="size-4" strokeWidth={1.75} />
            Survey
          </Link>
        ) : (
          <button
            type="button"
            disabled
            title="This lead is closed"
            className="flex min-h-11 items-center justify-center gap-2 text-[13px] font-semibold text-[#98A2B3]"
          >
            <CalendarPlus className="size-4" strokeWidth={1.75} />
            Survey
          </button>
        )}
        <Link
          href={`/quotes/new?leadId=${lead.id}`}
          prefetch={false}
          title="New quote"
          aria-label={`New quote for ${lead.name ?? "lead"}`}
          className="focus-ring flex min-h-11 items-center justify-center gap-2 text-[13px] font-semibold text-[#344054] hover:bg-[#F7F8FA]"
        >
          <FileText className="size-4" strokeWidth={1.75} />
          Quote
        </Link>
      </div>
    </article>
  );
}
