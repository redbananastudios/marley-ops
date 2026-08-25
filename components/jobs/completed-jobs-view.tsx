"use client";

/**
 * Completed Jobs — the browsable history of finished moves. The office already
 * has these scattered across Leads (status=completed), Documents (certificates)
 * and Performance (aggregates); this is the one chronological ledger. Each row
 * links to its lead. Prices show — this is an office-only surface.
 *
 * Layout mirrors the Quotes view (table-ish on desktop, cards on mobile) with a
 * URL-driven debounced search so the server re-filters the whole history, not
 * just the visible page.
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FileDown, History, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { UK_TZ } from "@/lib/uk-time";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pager, usePager } from "@/components/ui/pager";
import { BrandChip, type BrandChipData } from "@/components/brand/brand-chip";
import { BrandFilter } from "@/components/brand/brand-filter";
import type { CompletedJobRow } from "@/lib/completed-jobs";

export type CompletedJobRowView = CompletedJobRow & {
  certificateUrl: string | null;
  /** Brand slug (leads.brand) — resolved to chip data via the page's
   *  active-brand list. Optional so the view stays safe without it. */
  brand?: string | null;
};

const gbp = (n: number | null): string =>
  n == null || Number.isNaN(n)
    ? "—"
    : "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function moveDate(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: UK_TZ });
}

function reviewChip(row: CompletedJobRowView) {
  if (row.review === "sent") {
    const when = row.reviewAt
      ? new Date(row.reviewAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: UK_TZ })
      : null;
    return (
      <span className="inline-flex shrink-0 items-center rounded-pill bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">
        {when ? `Review sent ${when}` : "Review sent"}
      </span>
    );
  }
  if (row.review === "off") {
    return (
      <span className="inline-flex shrink-0 items-center rounded-pill bg-mist-50 px-2 py-0.5 text-[11px] font-medium text-mist-400">
        Review off
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-pill bg-mist-100 px-2 py-0.5 text-[11px] font-medium text-charcoal">
      Review pending
    </span>
  );
}

export function CompletedJobsView({
  rows,
  query = "",
  brands = [],
  showBrandChips = false,
}: {
  rows: CompletedJobRowView[];
  /** Active server-side search term (URL `q`) — seeds the input and empty state. */
  query?: string;
  /** Active brands (multi-brand PRD §4) — filter options + chip data. Empty or
   *  single-entry → no brand UI renders (the single-brand invariant, PRD §1). */
  brands?: BrandChipData[];
  /** True only in multi-brand mode with the ?brand= filter on All — the chip is
   *  hidden when the segmented control already names a single brand. */
  showBrandChips?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(query);

  const brandBySlug = useMemo(() => new Map(brands.map((b) => [b.slug, b])), [brands]);

  // Push the debounced term into the URL so the server re-filters the whole
  // history. Only navigate when it actually differs from what the server has.
  useEffect(() => {
    const id = setTimeout(() => {
      const next = search.trim();
      if (next === query) return;
      startTransition(() => {
        // Rebuild from the live params so the ?brand= filter (and anything
        // else on the URL) survives a search — multi-brand PRD §4.
        const params = new URLSearchParams(searchParams.toString());
        if (next) params.set("q", next);
        else params.delete("q");
        const qs = params.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    }, 300);
    return () => clearTimeout(id);
  }, [search, query, pathname, router, searchParams]);

  const pager = usePager(rows, 25);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="tabular text-sm text-mist-400">
          {rows.length} {rows.length === 1 ? "completed job" : "completed jobs"}
        </p>
        {/* Brand filter (multi-brand PRD §4 Pipeline and jobs) — joins the
            existing search form row. Renders nothing below 2 brands. */}
        {brands.length > 1 ? <BrandFilter brands={brands} /> : null}
        <div className="relative ml-auto min-w-0 flex-1 sm:max-w-xs">
          <Search strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer or quote ref"
            className="pl-9 pr-9 text-base"
            aria-label="Search completed jobs"
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

      <ul className={cn("divide-y rounded-lg border border-border bg-card transition-opacity", isPending && "opacity-60")}>
        {rows.length === 0 ? (
          <li>
            <EmptyState
              icon={History}
              title={query ? `No completed jobs match “${query}”` : "No completed jobs yet."}
              hint={
                query
                  ? "Try a different search, or clear it."
                  : "Jobs land here once the crew sign off the move on completion."
              }
            />
          </li>
        ) : (
          pager.paged.map((r) => (
            <li
              key={r.leadId}
              className="flex flex-col gap-2 px-4 py-3 hover:bg-muted/60 sm:min-h-14 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
            >
              <Link href={`/leads/${r.leadId}`} className="flex min-w-0 items-center gap-4 sm:flex-1">
                <span className="tabular hidden w-28 shrink-0 text-sm text-mist-500 sm:block">{moveDate(r.moveAt)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{r.customer}</span>
                    {r.quoteRef ? <span className="tabular shrink-0 text-xs text-mist-400">{r.quoteRef}</span> : null}
                  </span>
                  {/* Brand chip — in the customer column beneath the quote ref,
                      leading the subline; hidden when the ?brand= filter already
                      names one brand (multi-brand PRD §4 Pipeline and jobs).
                      16px — the tight sub-line size. Without a chip the markup
                      is exactly today's (the single-brand invariant, PRD §1). */}
                  {(() => {
                    const b = showBrandChips && r.brand ? brandBySlug.get(r.brand) : undefined;
                    return b ? (
                      <span className="flex items-center gap-1.5">
                        <BrandChip brand={b} size={16} />
                        <span className="min-w-0 truncate text-xs text-mist-400 sm:hidden">Moved {moveDate(r.moveAt)}</span>
                        {r.route ? <span className="hidden min-w-0 truncate text-xs text-mist-400 sm:block">{r.route}</span> : null}
                      </span>
                    ) : (
                      <>
                        <span className="block truncate text-xs text-mist-400 sm:hidden">Moved {moveDate(r.moveAt)}</span>
                        {r.route ? <span className="hidden truncate text-xs text-mist-400 sm:block">{r.route}</span> : null}
                      </>
                    );
                  })()}
                </span>
              </Link>

              <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3">
                <span className="tabular order-last shrink-0 text-sm font-semibold text-foreground sm:order-none sm:w-20 sm:text-right">
                  {gbp(r.value)}
                </span>
                {r.certificateUrl ? (
                  <a
                    href={r.certificateUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground hover:bg-muted"
                    title="Completion certificate"
                  >
                    <FileDown className="size-3.5" strokeWidth={1.75} />
                    PDF
                  </a>
                ) : (
                  <span className="w-11 shrink-0 text-center text-xs text-mist-300" aria-label="No certificate">
                    —
                  </span>
                )}
                {reviewChip(r)}
                {r.hasExceptions ? (
                  <span className="inline-flex shrink-0 items-center rounded-pill bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn">
                    Exceptions
                  </span>
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
