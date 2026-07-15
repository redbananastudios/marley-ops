"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ArrowDown,
  ArrowUp,
  Building2,
  CornerDownLeft,
  FileText,
  Search,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { LeadStatusBadge } from "@/components/lead-status-badge";
import { QuoteStatusPill } from "@/components/quote/quote-status-pill";
import { globalSearchAction } from "@/app/actions/global-search";
import {
  MIN_SEARCH_LEN,
  sanitiseSearchTerm,
  type GlobalSearchResults,
} from "@/components/search/search-utils";
import { SEARCH_OPEN_EVENT } from "@/components/search/open-search";

type Group = "lead" | "client" | "quote";

interface FlatItem {
  key: string;
  group: Group;
  href: string;
  icon: LucideIcon;
  title: string;
  subtitle: string | null;
  status?: string;
}

const GROUP_LABEL: Record<Group, string> = {
  lead: "Leads",
  client: "Clients",
  quote: "Quotes",
};

/** Order the flat list the same way it reads on screen: leads, clients, quotes. */
function flatten(results: GlobalSearchResults): FlatItem[] {
  const items: FlatItem[] = [];

  for (const l of results.leads) {
    const route = [l.fromPostcode, l.toPostcode].filter(Boolean).join(" → ");
    items.push({
      key: `lead:${l.id}`,
      group: "lead",
      href: `/leads/${l.id}`,
      icon: UserRound,
      title: l.name?.trim() || "Unnamed lead",
      subtitle: route || null,
      status: l.status,
    });
  }
  for (const c of results.clients) {
    items.push({
      key: `client:${c.id}`,
      group: "client",
      href: `/clients/${c.id}`,
      icon: Building2,
      title: c.name?.trim() || "Unnamed client",
      subtitle: c.subtitle,
    });
  }
  for (const qt of results.quotes) {
    items.push({
      key: `quote:${qt.id}`,
      group: "quote",
      href: `/quotes/${qt.id}`,
      icon: FileText,
      title: qt.ref?.trim() || "Quote",
      subtitle: qt.name?.trim() || null,
      status: qt.status,
    });
  }
  return items;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const reqRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const flat = useMemo(() => (results ? flatten(results) : []), [results]);
  const term = sanitiseSearchTerm(query);
  const showHint = term.length < MIN_SEARCH_LEN;
  const noMatches = !showHint && !loading && results !== null && flat.length === 0;

  // Global Cmd/Ctrl-K toggle + the decoupled "open" event from the mobile button.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(SEARCH_OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SEARCH_OPEN_EVENT, onOpenEvent);
    };
  }, []);

  // Debounced search (250ms). A per-keystroke request id discards stale
  // responses so a slow early query can never overwrite a newer one.
  useEffect(() => {
    if (!open) return;
    if (term.length < MIN_SEARCH_LEN) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const reqId = ++reqRef.current;
    const t = setTimeout(() => {
      globalSearchAction(query)
        .then((res) => {
          if (reqRef.current !== reqId) return;
          setResults(res);
          setActiveIndex(0);
        })
        .catch(() => {
          if (reqRef.current !== reqId) return;
          setResults({ leads: [], clients: [], quotes: [] });
        })
        .finally(() => {
          if (reqRef.current === reqId) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
    // `term` is derived from `query`; depending on both keeps lint happy.
  }, [query, term, open]);

  // Keep the highlighted row in view as the user arrows through.
  useEffect(() => {
    if (!flat.length) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, flat.length]);

  const select = useCallback(
    (item: FlatItem | undefined) => {
      if (!item) return;
      setOpen(false);
      router.push(item.href);
    },
    [router],
  );

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!flat.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(flat[activeIndex]);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // Reset so the next open is a clean sheet.
      setQuery("");
      setResults(null);
      setLoading(false);
      setActiveIndex(0);
    }
  }

  // Render the groups in list order, tracking the running flat index so the
  // keyboard highlight and the on-screen rows stay in lockstep.
  let cursor = -1;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-label="Search"
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-background shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">
            Search leads, clients and quotes
          </DialogPrimitive.Title>

          {/* Search field */}
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search leads, clients and quotes"
              aria-label="Search leads, clients and quotes"
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls="mm-search-results"
              autoComplete="off"
              spellCheck={false}
              // 16px prevents the iOS focus-zoom; also the design's base size.
              className="h-14 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
            />
            {loading ? (
              <span className="shrink-0 text-xs text-muted-foreground">Searching…</span>
            ) : null}
          </div>

          {/* Results */}
          <div
            ref={listRef}
            id="mm-search-results"
            role="listbox"
            aria-label="Search results"
            className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain py-1"
          >
            {showHint ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                Search leads, clients and quotes — try a name, postcode or MMR ref
              </p>
            ) : noMatches ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No matches for &ldquo;{query.trim()}&rdquo;
              </p>
            ) : (
              (["lead", "client", "quote"] as const).map((group) => {
                const groupItems = flat.filter((it) => it.group === group);
                if (!groupItems.length) return null;
                return (
                  <div key={group} className="py-1">
                    <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {GROUP_LABEL[group]}
                    </p>
                    {groupItems.map((item) => {
                      cursor += 1;
                      const index = cursor;
                      const active = index === activeIndex;
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          data-index={index}
                          role="option"
                          aria-selected={active}
                          onMouseMove={() => setActiveIndex(index)}
                          onClick={() => select(item)}
                          className={cn(
                            "flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                            active ? "bg-accent" : "hover:bg-accent/60",
                          )}
                        >
                          <Icon
                            className="size-4 shrink-0 text-muted-foreground"
                            strokeWidth={1.75}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">
                              {item.title}
                            </span>
                            {item.subtitle ? (
                              <span className="block truncate text-xs text-muted-foreground">
                                {item.subtitle}
                              </span>
                            ) : null}
                          </span>
                          {item.status ? (
                            group === "quote" ? (
                              <QuoteStatusPill status={item.status} />
                            ) : (
                              <LeadStatusBadge status={item.status} />
                            )
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer hint */}
          <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-[11px] text-muted-foreground">
            <span className="hidden items-center gap-3 sm:flex">
              <span className="flex items-center gap-1">
                <Kbd>
                  <ArrowUp className="size-3" strokeWidth={2} aria-hidden />
                </Kbd>
                <Kbd>
                  <ArrowDown className="size-3" strokeWidth={2} aria-hidden />
                </Kbd>
                to navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd>
                  <CornerDownLeft className="size-3" strokeWidth={2} aria-hidden />
                </Kbd>
                to open
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Esc</Kbd>
                to close
              </span>
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border bg-muted px-1 py-0.5 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}
