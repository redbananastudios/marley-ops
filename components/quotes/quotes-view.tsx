"use client";

/**
 * Quotes triage + insight view. A summary band (open pipeline £, won £, win rate,
 * awaiting reply) over a filtered list: preset chips (All / Draft / Awaiting reply
 * / Accepted) with counts + search, rich rows (ref, customer, route, value, status,
 * sent count, follow-up urgency on sent-but-unanswered quotes) and an open-lead
 * quick action. Responsive: table-ish on desktop, cards on mobile.
 */

import { useEffect, useMemo, useRef, useState, useTransition, type MouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ClipboardCheck, MoreHorizontal, Search, Trash2, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pager, usePager } from "@/components/ui/pager";
import { filterChipClass, filterChipCountClass } from "@/components/ui/segmented";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AcceptQuoteButton } from "@/components/quote/accept-quote-button";
import { DeleteQuoteButton } from "@/components/quote/delete-quote-button";
import { QuoteStatusPill } from "@/components/quote/quote-status-pill";

export interface QuoteRow {
  id: string;
  quote_ref: string | null;
  customer_name: string | null;
  collect_addr: string | null;
  dest_addr: string | null;
  grand_total: number | null;
  agreed_price: number | null;
  status: string;
  email_send_count: number | null;
  accepted_at: string | null;
  lead_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** The real send timestamp. Unlike updated_at (reset by the BEFORE-UPDATE
   *  trigger on any row write) this only stamps when the quote is emailed, so
   *  it's the honest anchor for the "sent … ago" chase clock. Optional so the
   *  view stays safe if the page query hasn't selected it. */
  email_sent_at?: string | null;
  deposit_paid_at?: string | null;
}

type PresetKey = "all" | "draft" | "sent" | "accepted";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n)
    ? "—"
    : "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function dateShort(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function ago(d: string | null, now: number): string {
  if (!d) return "";
  const mins = Math.floor((now - new Date(d).getTime()) / 60000);
  if (mins < 60) return `${Math.max(0, mins)}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Sent-but-unanswered → chase nudge, escalating with age. `now` is captured
 *  once per mount upstream (react-hooks/purity: no Date.now() in render). */
function FollowUp({ quote, now }: { quote: QuoteRow; now: number }) {
  if (quote.status !== "sent") return null;
  // Anchor on the true send time. updated_at is reset to now() by the quotes
  // BEFORE-UPDATE trigger on any row write (edit, reassign), which would flip a
  // genuinely-cold quote back to "sent 0m ago" and drop it off the chase radar.
  const since = quote.email_sent_at ?? quote.created_at;
  const days = since ? Math.floor((now - new Date(since).getTime()) / 86_400_000) : 0;
  const tone = days >= 7 ? "bg-danger-bg text-danger" : days >= 3 ? "bg-warn-bg text-warn" : "bg-mist-100 text-charcoal";
  return (
    <span className={cn("inline-flex items-center rounded-pill px-2 py-0.5 text-[11px] font-medium", tone)}>
      sent {ago(since, now)} ago · follow up
    </span>
  );
}

/** One quote per lead — prefer the accepted one, else the latest by created_at;
 *  draft + superseded excluded. Orphans (no lead_id) each stand alone. Mirrors
 *  lib/sales-report.ts dedupePerLead so the win rate agrees with the Sales tab. */
export function dedupePerLead(quotes: QuoteRow[]): QuoteRow[] {
  const byLead = new Map<string, QuoteRow>();
  const orphans: QuoteRow[] = [];
  for (const q of quotes) {
    if (q.status === "superseded" || q.status === "draft") continue;
    if (!q.lead_id) {
      orphans.push(q);
      continue;
    }
    const cur = byLead.get(q.lead_id);
    if (!cur) {
      byLead.set(q.lead_id, q);
      continue;
    }
    const better =
      (q.status === "accepted" && cur.status !== "accepted") ||
      ((q.status === "accepted") === (cur.status === "accepted") &&
        (q.created_at ?? "") > (cur.created_at ?? ""));
    if (better) byLead.set(q.lead_id, q);
  }
  return [...byLead.values(), ...orphans];
}

/** Summary-band figures. Win rate is deduped per lead with draft + superseded
 *  dropped (a superseded re-quote is the SAME opportunity, not a separate loss),
 *  matching lib/sales-report.ts — so re-quoting a lead no longer deflates the rate. */
export function computeQuoteStats(quotes: QuoteRow[]) {
  const deduped = dedupePerLead(quotes);
  const accepted = quotes.filter((q) => q.status === "accepted");
  const sent = quotes.filter((q) => q.status === "sent");
  const dedupedAccepted = deduped.filter((q) => q.status === "accepted").length;
  return {
    openValue: sent.reduce((s, q) => s + (q.grand_total ?? 0), 0),
    wonValue: accepted.reduce((s, q) => s + (q.agreed_price ?? q.grand_total ?? 0), 0),
    winRate: deduped.length ? Math.round((dedupedAccepted / deduped.length) * 100) : 0,
    awaiting: sent.length,
  };
}

function routeLine(q: QuoteRow): string {
  const f = q.collect_addr?.trim();
  const t = q.dest_addr?.trim();
  if (f && t) return `${f} → ${t}`;
  if (f) return `from ${f}`;
  if (t) return `to ${t}`;
  return "—";
}

export function QuotesView({
  quotes,
  defaultDeposit = 100,
  query = "",
}: {
  quotes: QuoteRow[];
  defaultDeposit?: number;
  /** Active server-side search term (URL `q`) — seeds the input and empty state. */
  query?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [preset, setPreset] = useState<PresetKey>("all");
  // The input is the source of truth for what's typed; the URL `q` (server-filtered)
  // is synced from it, debounced. `quotes` already arrives filtered by the server.
  const [search, setSearch] = useState(query);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leavingListRef = useRef(false);
  // Stable clock for the age chips — lazy useState keeps render pure.
  const [now] = useState(() => Date.now());

  // Push the debounced search term into the URL so the server re-filters. Only
  // navigate when it differs from what the server already has, so a round-trip
  // returning the same `q` doesn't re-fire the effect into a loop.
  useEffect(() => {
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null;
      if (leavingListRef.current) return;
      const next = search.trim();
      if (next === query) return;
      startTransition(() => {
        router.replace(next ? `${pathname}?q=${encodeURIComponent(next)}` : pathname, { scroll: false });
      });
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    };
  }, [search, query, pathname, router]);

  function cancelPendingSearch() {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
  }

  function leaveList(event: MouseEvent<HTMLAnchorElement>) {
    // Keep the current tab fully interactive for Ctrl/Cmd/Shift-clicks that
    // open the quote elsewhere.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // A fast click can otherwise race the debounced `router.replace` and be
    // pulled back to /quotes?q=... after the detail navigation has started.
    leavingListRef.current = true;
    cancelPendingSearch();
  }

  const stats = useMemo(() => computeQuoteStats(quotes), [quotes]);

  const counts = useMemo(
    () => ({
      all: quotes.length,
      draft: quotes.filter((q) => q.status === "draft").length,
      sent: quotes.filter((q) => q.status === "sent").length,
      accepted: quotes.filter((q) => q.status === "accepted").length,
    }),
    [quotes],
  );

  // Search is applied server-side (ref + customer/lead name + lead postcode); the
  // chips filter within that result set.
  const visible = useMemo(
    () => quotes.filter((q) => (preset === "all" ? true : q.status === preset)),
    [quotes, preset],
  );

  const pager = usePager(visible, 25);

  const PRESETS: { key: PresetKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "draft", label: "Draft" },
    { key: "sent", label: "Awaiting reply" },
    { key: "accepted", label: "Accepted" },
  ];

  return (
    <div>
      {/* summary band */}
      <section className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open pipeline" value={gbp(stats.openValue)} sub={`${stats.awaiting} awaiting reply`} />
        <Stat label="Won" value={gbp(stats.wonValue)} good={stats.wonValue > 0} />
        <Stat label="Win rate" value={`${stats.winRate}%`} sub="of quoted leads" />
        <Stat label="Quotes" value={String(counts.all)} sub={`${counts.draft} draft`} />
      </section>

      {/* presets + search */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => {
          const active = preset === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              aria-pressed={active}
              className={filterChipClass(active)}
            >
              {p.label}
              <span className={filterChipCountClass(active)}>{counts[p.key]}</span>
            </button>
          );
        })}
        {/* basis-full drops the search onto its own full-width row on phones —
            flex-1 alone squeezed it into the sliver left beside the chips and
            the input poked past the viewport edge. */}
        <div className="relative min-w-0 basis-full sm:ml-auto sm:basis-auto sm:flex-1 sm:max-w-xs">
          <Search strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer, ref, postcode"
            className="pl-9 pr-9 text-base"
            aria-label="Search quotes"
            enterKeyHint="search"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="focus-ring absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-mist-400 hover:text-foreground"
            >
              <X strokeWidth={1.75} className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* list — paged so big datasets stay fast */}
      <ul className={cn("mt-4 divide-y rounded-lg border border-border bg-card transition-opacity", isPending && "opacity-60")}>
        {visible.length === 0 ? (
          <li>
            <EmptyState
              icon={ClipboardCheck}
              title={query ? `No quotes match “${query}”` : "No quotes match"}
              hint={query ? "Try a different search, or clear it." : "Change the filter, or start one with New quote."}
            />
          </li>
        ) : (
          pager.paged.map((q) => (
            <li
              key={q.id}
              onClickCapture={cancelPendingSearch}
              className="flex flex-col gap-2 px-4 py-3 hover:bg-muted/60 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
            >
              <Link href={`/quotes/${q.id}`} onClick={leaveList} className="flex min-w-0 items-center gap-3 sm:flex-1">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{q.customer_name?.trim() || "New quote"}</span>
                    <span className="tabular shrink-0 text-xs text-mist-400">{q.quote_ref}</span>
                  </span>
                  <span className="block truncate text-xs text-mist-400">{routeLine(q)}</span>
                </span>
              </Link>

              <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3">
                <div className="mr-auto sm:mr-0">
                  <FollowUp quote={q} now={now} />
                </div>
                <span className="tabular shrink-0 text-sm font-semibold text-foreground">
                  {q.status === "accepted" ? gbp(q.agreed_price ?? q.grand_total) : gbp(q.grand_total)}
                </span>
                <div className="shrink-0">
                  <QuoteStatusPill status={q.status} />
                </div>
                {q.email_send_count && q.email_send_count > 0 ? (
                  <span className="tabular hidden shrink-0 text-xs text-mist-400 md:inline">×{q.email_send_count}</span>
                ) : null}
                <span className="tabular hidden w-14 shrink-0 text-right text-xs text-mist-400 md:inline">{dateShort(q.created_at)}</span>
                {/* Convert: live quotes accept in place; accepted ones hand over to Bookings. */}
                {q.status === "draft" || q.status === "sent" ? (
                  <AcceptQuoteButton
                    quoteId={q.id}
                    grandTotal={Number(q.grand_total ?? 0)}
                    status={q.status}
                    depositAmount={defaultDeposit}
                    compact
                  />
                ) : q.status === "accepted" ? (
                  <Link
                    href="/bookings"
                    className={cn(
                      "focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold",
                      q.deposit_paid_at
                        ? "border-success-border bg-success-bg text-success"
                        : "border-warn-border bg-warn-bg text-warn",
                    )}
                    title="Manage in Bookings"
                  >
                    <ClipboardCheck className="size-3.5" strokeWidth={2} />
                    {q.deposit_paid_at ? "Deposit paid" : "Awaiting deposit"}
                  </Link>
                ) : null}
                {q.lead_id ? (
                  <Link
                    href={`/leads/${q.lead_id}`}
                    title="Open lead"
                    aria-label="Open lead"
                    className="focus-ring flex size-9 shrink-0 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground"
                  >
                    <Users className="size-4" strokeWidth={1.75} />
                  </Link>
                ) : null}
                <RowActions quote={q} />
              </div>
            </li>
          ))
        )}
      </ul>
      <Pager
        page={pager.page}
        pages={pager.pages}
        total={pager.total}
        pageSize={pager.pageSize}
        onPage={pager.setPage}
        className="mt-4"
      />
    </div>
  );
}

/** Per-row overflow → Delete. Behind a "⋯" menu so the delete never sits a
 *  stray-click away on a dense list. Reuses the detail page's DeleteQuoteButton
 *  in controlled mode, so the confirm — and the extra "removes a recorded win"
 *  warning on sent/accepted quotes — is byte-for-byte the same everywhere. The
 *  deleteQuote action revalidates /quotes, so this force-dynamic list re-renders
 *  and the row drops out on success (no manual refresh needed). */
function RowActions({ quote }: { quote: QuoteRow }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Defer opening until the menu has closed, so Radix's focus-return and the
  // dialog's focus-trap don't fight over the same tick (mirrors the header).
  const openDelete = () => window.setTimeout(() => setDeleteOpen(true), 0);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More actions"
            className="focus-ring flex size-9 shrink-0 items-center justify-center rounded-md text-mist-400 hover:bg-muted hover:text-foreground"
          >
            <MoreHorizontal className="size-4" strokeWidth={1.75} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem variant="destructive" onSelect={openDelete}>
            <Trash2 strokeWidth={1.75} />
            Delete quote
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteQuoteButton
        quoteId={quote.id}
        status={quote.status}
        quoteRef={quote.quote_ref ?? ""}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
}

function Stat({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="eyebrow">{label}</p>
      <p className={cn("mt-1 font-display tabular text-2xl font-bold", good ? "text-success" : "text-foreground")}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </div>
  );
}
