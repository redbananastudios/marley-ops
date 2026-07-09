"use client";

/**
 * Quotes triage + insight view. A summary band (open pipeline £, won £, win rate,
 * awaiting reply) over a filtered list: preset chips (All / Draft / Awaiting reply
 * / Accepted) with counts + search, rich rows (ref, customer, route, value, status,
 * sent count, follow-up urgency on sent-but-unanswered quotes) and an open-lead
 * quick action. Responsive: table-ish on desktop, cards on mobile.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ClipboardCheck, Search, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Pager, usePager } from "@/components/ui/pager";
import { AcceptQuoteButton } from "@/components/quote/accept-quote-button";

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

const STATUS_PILL: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-mist-100 text-charcoal" },
  sent: { label: "Sent", className: "bg-mm-red-tint text-mm-red-deep" },
  accepted: { label: "Accepted", className: "bg-success-bg text-success" },
  rejected: { label: "Rejected", className: "bg-mist-50 text-mist-400" },
  superseded: { label: "Superseded", className: "bg-mist-50 text-mist-400" },
};

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

function ago(d: string | null): string {
  if (!d) return "";
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 60) return `${Math.max(0, mins)}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_PILL[status] ?? { label: status, className: "bg-mist-100 text-charcoal" };
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-pill px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide", s.className)}>
      {s.label}
    </span>
  );
}

/** Sent-but-unanswered → chase nudge, escalating with age. */
function FollowUp({ quote }: { quote: QuoteRow }) {
  if (quote.status !== "sent") return null;
  const since = quote.updated_at || quote.created_at;
  const days = since ? Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000) : 0;
  const tone = days >= 7 ? "bg-danger-bg text-danger" : days >= 3 ? "bg-warn-bg text-warn" : "bg-mm-red-tint text-mm-red-deep";
  return (
    <span className={cn("inline-flex items-center rounded-pill px-2 py-0.5 text-[11px] font-medium", tone)}>
      sent {ago(since)} ago · follow up
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
}: {
  quotes: QuoteRow[];
  defaultDeposit?: number;
}) {
  const [preset, setPreset] = useState<PresetKey>("all");
  const [search, setSearch] = useState("");

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

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return quotes
      .filter((q) => (preset === "all" ? true : q.status === preset))
      .filter((q) => {
        if (!term) return true;
        return [q.customer_name, q.quote_ref, q.collect_addr, q.dest_addr]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term));
      });
  }, [quotes, preset, search]);

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
              className={cn(
                "focus-ring inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-sm font-medium transition-colors",
                active ? "border-mm-red bg-mm-red-tint text-mm-red-deep" : "border-border bg-card text-mist-500 hover:bg-muted",
              )}
            >
              {p.label}
              <span className={cn("tabular rounded-pill px-1.5 text-xs", active ? "bg-mm-red/15 text-mm-red-deep" : "bg-muted text-mist-400")}>
                {counts[p.key]}
              </span>
            </button>
          );
        })}
        <div className="relative ml-auto min-w-0 flex-1 sm:max-w-xs">
          <Search strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer, ref, postcode" className="pl-9" aria-label="Search quotes" />
        </div>
      </div>

      {/* list — paged so big datasets stay fast */}
      <ul className="mt-4 divide-y rounded-lg border border-border bg-card">
        {visible.length === 0 ? (
          <li className="px-5 py-12 text-center text-sm text-mist-400">No quotes match.</li>
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
                  <FollowUp quote={q} />
                </div>
                <span className="tabular shrink-0 text-sm font-semibold text-foreground">
                  {q.status === "accepted" ? gbp(q.agreed_price ?? q.grand_total) : gbp(q.grand_total)}
                </span>
                <div className="shrink-0">
                  <StatusPill status={q.status} />
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
