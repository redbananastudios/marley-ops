"use client";

/**
 * Client-side pagination for the big list views (leads, quotes, clients). Filtering
 * and search stay instant across the full dataset; only the RENDER is paged so the
 * DOM stays small at hundreds/thousands of rows. usePager clamps the page when a
 * filter shrinks the list, so callers never manage out-of-range state.
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function usePager<T>(items: T[], pageSize = 24) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages - 1);
  const paged = useMemo(
    () => items.slice(current * pageSize, current * pageSize + pageSize),
    [items, current, pageSize],
  );
  return { paged, page: current, pages, total: items.length, pageSize, setPage };
}

export function Pager({
  page,
  pages,
  total,
  pageSize,
  onPage,
  className,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
  className?: string;
}) {
  if (pages <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="tabular text-xs text-mist-400">
        Showing {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
          aria-label="Previous page"
          className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-card px-2.5 text-sm font-medium text-mist-500 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40"
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
          Prev
        </button>
        <span className="tabular px-1 text-xs text-mist-400">
          {page + 1} / {pages}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages - 1}
          aria-label="Next page"
          className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-card px-2.5 text-sm font-medium text-mist-500 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-40"
        >
          Next
          <ChevronRight className="size-4" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
