"use client";

/**
 * Quotes triage + insight view. A summary band (open pipeline £, won £, win rate,
 * awaiting reply) over a filtered list: preset chips (All / Draft / Awaiting reply
 * / Accepted) with counts + search, rich rows (ref, customer, route, value, status,
 * sent count, follow-up urgency on sent-but-unanswered quotes) and an open-lead
 * quick action. Responsive: table-ish on desktop, cards on mobile.
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ClipboardCheck, Search, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pager, usePager } from "@/components/ui/pager";
import { filterChipClass, filterChipCountClass } from "@/components/ui/segmented";
import { AcceptQuoteButton } from "@/components/quote/accept-quote-button";
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
  const since = quote.updated_at || quote.created_at;
  const days = since ? Math.floor((now - new Date(since).getTime()) / 86_400_000) : 0;
  const tone = days >= 7 ? "bg-danger-bg text-danger" : days >= 3 ? "bg-warn-bg text-warn" : "bg-mm-red-tint text-mm-red-deep";
  return (
    <span className={cn("inline-flex items-center rounded-pill px-2 py-0.5 text-[11px] font-medium", tone)}>
      sent {ago(since, now)} ago · follow up
    </span>
  );
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
  // Stable clock for the age chips — lazy useState keeps render pure.
  const [now] = useState(() => Date.now());

  // Push the debounced search term into the URL so the server re-filters. Only
  // navigate when it differs from what the server already has, so a round-trip
  // returning the same `q` doesn't re-fire the effect into a loop.
  useEffect(() => {
    const id = setTimeout(() => {
      const next = search.trim();
      if (next === query) return;
      startTransition(() => {
        router.replace(next ? `${pathname}?q=${encodeURIComponent(next)}` : pathname, { scroll: false });
      });
    }, 300);
    return () => clearTimeout(id);
  }, [search, query, pathname, router]);

  const stats = useMemo(() => {
    const nonDraft = quotes.filter((q) => q.status !== "draft");
    const accepted = quotes.filter((q) => q.status === "accepted");
    const sent = quotes.filter((q) => q.status === "sent");
    return {
      openValue: sent.reduce((s, q) => s + (q.grand_total ?? 0), 0),
      wonValue: accepted.reduce((s, q) => s + (q.agreed_price ?? q.grand_total ?? 0), 0),
      winRate: nonDraft.length ? Math.round((accepted.length / nonDraft.length) * 100) : 0,
      awaiting: sent.length,
    };
  }, [quotes]);

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
        <Stat label="Win rate" value={`${stats.winRate}%`} sub="of sent quotes" />
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
            <li key={q.id} className="flex flex-col gap-2 px-4 py-3 hover:bg-muted/60 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
              <Link href={`/quotes/${q.id}`} className="flex min-w-0 items-center gap-3 sm:flex-1">
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

function Stat({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="eyebrow">{label}</p>
      <p className={cn("mt-1 font-display tabular text-2xl font-bold", good ? "text-success" : "text-foreground")}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </div>
  );
}
