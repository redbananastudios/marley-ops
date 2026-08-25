"use client";

/**
 * Clients directory — the person/household records (the dedupe target). Two view
 * formats (Grid cards / List table) with search + sort, built to stay usable at
 * hundreds of clients. Grid cards show contact, acquisition origin, enquiry count
 * + last enquiry and a repeat-customer marker; the A–Z jump rail appears when
 * sorted by name. View choice persists per device.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Search,
  Repeat,
  Phone,
  Mail,
  MapPin,
  Building2,
  ExternalLink,
  Route,
  Clock,
  LayoutGrid,
  List,
  Users,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Pager, usePager } from "@/components/ui/pager";
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { EmptyState } from "@/components/ui/empty-state";
import { EmailComposeDialog } from "@/components/comms/email-compose-dialog";
import { BrandChip, type BrandChipData } from "@/components/brand/brand-chip";
import { BrandFilter } from "@/components/brand/brand-filter";
import { SOURCES, type SourceKey } from "@/lib/dashboard/compute";

const ALPHABET = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];

/** First-letter bucket for the A–Z index ("#" for names that don't start A–Z). */
function letterOf(name: string | null): string {
  const c = (name ?? "").trim().charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

export interface ClientRow {
  id: string;
  display_name: string | null;
  isCompany: boolean;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  address: string | null;
  leadCount: number;
  lastLeadAt: string | null;
  origin: SourceKey;
  /** Brand slugs this client has LEADS under (derived, never stored —
   *  multi-brand PRD §4 Clients). Empty in single-brand mode. */
  brands: string[];
}

const SOURCE_COLOR: Record<SourceKey, string> = Object.fromEntries(
  SOURCES.map((s) => [s.key, s.color]),
) as Record<SourceKey, string>;
const SOURCE_LABEL: Record<SourceKey, string> = Object.fromEntries(
  SOURCES.map((s) => [s.key, s.label]),
) as Record<SourceKey, string>;

function dateShort(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function OriginBadge({ origin }: { origin: SourceKey }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-muted px-2 py-0.5 text-[11px] font-medium text-mist-500">
      <span className="size-2 rounded-full" style={{ background: SOURCE_COLOR[origin] }} />
      {SOURCE_LABEL[origin]}
    </span>
  );
}

type ViewMode = "grid" | "list";
type SortKey = "newest" | "oldest" | "name";

const VIEW_STORE = "mm-clients-view";

export function ClientsView({
  clients,
  baseLocation,
  brands = [],
  showBrandChips = false,
}: {
  clients: ClientRow[];
  baseLocation: string;
  /** Active brands (multi-brand PRD §4) — filter options + chip data. Empty or
   *  single-entry → no brand UI renders (the single-brand invariant, PRD §1). */
  brands?: BrandChipData[];
  /** True only in multi-brand mode with the ?brand= filter on All — chips are
   *  hidden when the segmented control already names a single brand. */
  showBrandChips?: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewMode>("grid");
  const [sort, setSort] = useState<SortKey>("newest");
  // One compose dialog for the whole view — rows just set the recipient.
  const [compose, setCompose] = useState<{ to: string; clientId: string } | null>(null);
  const repeat = useMemo(() => clients.filter((c) => c.leadCount > 1).length, [clients]);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // Chips per client, in brand sort order (the `brands` prop is already sorted).
  // Resolves to [] whenever chips are hidden, so no call site needs its own gate.
  const chipsFor = (c: ClientRow): BrandChipData[] =>
    showBrandChips && c.brands.length ? brands.filter((b) => c.brands.includes(b.slug)) : [];

  // Restore the device's view preference after mount (SSR-safe).
  useEffect(() => {
    const stored = window.localStorage.getItem(VIEW_STORE);
    if (stored === "grid" || stored === "list") setView(stored);
  }, []);

  function pickView(v: ViewMode) {
    setView(v);
    window.localStorage.setItem(VIEW_STORE, v);
  }

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = term
      ? clients.filter((c) =>
          [c.display_name, c.email, c.phone, c.postcode, c.address]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(term)),
        )
      : clients;
    const byName = (a: ClientRow, b: ClientRow) =>
      (a.display_name || "￿").localeCompare(b.display_name || "￿", "en-GB", { sensitivity: "base" });
    const byLast = (a: ClientRow, b: ClientRow) =>
      new Date(b.lastLeadAt ?? 0).getTime() - new Date(a.lastLeadAt ?? 0).getTime();
    return [...filtered].sort(sort === "name" ? byName : sort === "oldest" ? (a, b) => byLast(b, a) : byLast);
  }, [clients, search, sort]);

  // Render is paged (25/page) so hundreds of clients stay fast; search/sort still
  // operate on the full set.
  const pager = usePager(visible, 25);

  // A–Z sections only make sense when sorted by name (grid view) — sections are
  // built from the current page so the jump rail always matches what's on screen.
  const groups = useMemo(() => {
    if (sort !== "name") return null;
    const map = new Map<string, ClientRow[]>();
    for (const c of pager.paged) {
      const k = letterOf(c.display_name);
      (map.get(k) ?? map.set(k, []).get(k)!).push(c);
    }
    return ALPHABET.filter((l) => map.has(l)).map((l) => ({ letter: l, rows: map.get(l)! }));
  }, [pager.paged, sort]);

  const present = useMemo(() => new Set((groups ?? []).map((g) => g.letter)), [groups]);

  function jumpTo(letter: string) {
    sectionRefs.current[letter]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const toggleBtn = (v: ViewMode, Icon: typeof LayoutGrid, label: string) => (
    <button type="button" onClick={() => pickView(v)} aria-pressed={view === v} className={segmentedItemClass(view === v)}>
      <Icon className="size-4" strokeWidth={1.75} />
      {label}
    </button>
  );

  // Card presentation — the grid view proper, and also the automatic fallback for
  // list view below md (a 720px-wide table pans-and-hunts on a narrow iPad).
  const cardsContent = groups ? (
    /* ——— Card grid, name sort: A–Z sections + jump rail ——— */
    <div className="mt-4 flex gap-3">
      <div className="min-w-0 flex-1 space-y-6">
        {groups.map((g) => (
          <section
            key={g.letter}
            ref={(el) => {
              sectionRefs.current[g.letter] = el;
            }}
            className="scroll-mt-20"
          >
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-mist-400">{g.letter}</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.rows.map((c) => (
                <ClientCard key={c.id} c={c} chips={chipsFor(c)} baseLocation={baseLocation} onEmail={(to, id) => setCompose({ to, clientId: id })} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* A–Z jump rail */}
      <nav
        aria-label="Jump to letter"
        className="sticky top-4 hidden h-fit shrink-0 flex-col items-center gap-0.5 self-start py-1 sm:flex"
      >
        {ALPHABET.map((l) => {
          const enabled = present.has(l);
          return (
            <button
              key={l}
              type="button"
              disabled={!enabled}
              onClick={() => jumpTo(l)}
              className={cn(
                "focus-ring flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold leading-none transition-colors",
                enabled
                  ? "text-mist-500 hover:bg-mm-red-tint hover:text-mm-red-deep"
                  : "cursor-default text-mist-300/50",
              )}
              aria-label={enabled ? `Jump to ${l}` : `No clients under ${l}`}
            >
              {l}
            </button>
          );
        })}
      </nav>
    </div>
  ) : (
    /* ——— Card grid, date sorts: flat grid ——— */
    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {pager.paged.map((c) => (
        <ClientCard key={c.id} c={c} chips={chipsFor(c)} baseLocation={baseLocation} onEmail={(to, id) => setCompose({ to, clientId: id })} />
      ))}
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        {/* view toggle */}
        <div className={segmentedTrackClass} role="group" aria-label="View format">
          {toggleBtn("grid", LayoutGrid, "Grid")}
          {toggleBtn("list", List, "List")}
        </div>

        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email, postcode" className="pl-9" aria-label="Search clients" />
        </div>

        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="h-9 w-[140px]" aria-label="Sort clients">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="name">Name A–Z</SelectItem>
          </SelectContent>
        </Select>

        {/* Brand filter (multi-brand PRD §4 Clients) — joins the existing
            toggle/search/sort row. Renders nothing below 2 brands. Shows
            clients having at least one lead in the selected brand (the page
            narrows server-side off ?brand=). */}
        {brands.length > 1 ? <BrandFilter brands={brands} /> : null}

        <span className="text-xs text-mist-400">
          {clients.length} clients{repeat > 0 ? ` · ${repeat} repeat` : ""}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border bg-card">
          {clients.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No clients yet"
              hint="Clients are created automatically from leads, or use Add client to start one."
            />
          ) : (
            <EmptyState
              icon={Search}
              title="No clients match"
              hint="Try a different search, or clear it to see everyone."
            />
          )}
        </div>
      ) : view === "list" ? (
        /* ——— List view: dense table on md+, card grid on narrow screens ——— */
        <>
        <div className="mt-4 hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="eyebrow px-4 py-2.5 font-semibold">Client</th>
                {/* Brands column between Client and Phone (multi-brand PRD §4
                    Clients) — renders only in multi-brand mode with the filter
                    on All; a named filter already says the brand, so the
                    column goes with the chips. */}
                {showBrandChips ? <th className="eyebrow px-4 py-2.5 font-semibold">Brands</th> : null}
                <th className="eyebrow px-4 py-2.5 font-semibold">Phone</th>
                <th className="eyebrow px-4 py-2.5 font-semibold">Email</th>
                <th className="eyebrow px-4 py-2.5 font-semibold">Postcode</th>
                <th className="eyebrow px-4 py-2.5 text-right font-semibold">Enquiries</th>
                <th className="eyebrow px-4 py-2.5 text-right font-semibold">Last enquiry</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pager.paged.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/clients/${c.id}`)}
                  className="cursor-pointer transition-colors hover:bg-muted"
                >
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      {c.isCompany ? <Building2 className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} /> : null}
                      <Link href={`/clients/${c.id}`} className="focus-ring rounded-sm hover:underline" onClick={(e) => e.stopPropagation()}>
                        {c.display_name || "Unnamed"}
                      </Link>
                      {c.leadCount > 1 ? (
                        <span className="inline-flex items-center gap-0.5 rounded-pill bg-success-bg px-1.5 py-0.5 text-[10px] font-semibold text-success">
                          <Repeat className="size-2.5" strokeWidth={2} />
                          {c.leadCount}×
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block">
                      <OriginBadge origin={c.origin} />
                    </span>
                  </td>
                  {showBrandChips ? (
                    <td className="px-4 py-3">
                      {chipsFor(c).length ? (
                        <span className="flex items-center gap-1">
                          {chipsFor(c).map((b) => (
                            <BrandChip key={b.slug} brand={b} />
                          ))}
                        </span>
                      ) : (
                        <span className="text-mist-400">—</span>
                      )}
                    </td>
                  ) : null}
                  <td className="px-4 py-3 text-mist-500">
                    {c.phone ? (
                      <a href={`tel:${c.phone}`} onClick={(e) => e.stopPropagation()} className="focus-ring rounded-sm hover:text-foreground hover:underline">
                        {c.phone}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="max-w-[220px] truncate px-4 py-3 text-mist-500">
                    {c.email ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCompose({ to: c.email!, clientId: c.id });
                        }}
                        className="focus-ring max-w-full truncate rounded-sm text-left hover:text-foreground hover:underline"
                      >
                        {c.email}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-mist-500">{c.postcode ?? "—"}</td>
                  <td className="tabular px-4 py-3 text-right text-mist-500">{c.leadCount}</td>
                  <td className="tabular px-4 py-3 text-right text-mist-500">{dateShort(c.lastLeadAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Below md the wide table pans-and-hunts — fall back to the card grid. */}
        <div className="md:hidden">{cardsContent}</div>
        </>
      ) : (
        cardsContent
      )}

      <Pager
        page={pager.page}
        pages={pager.pages}
        total={pager.total}
        pageSize={pager.pageSize}
        onPage={pager.setPage}
        className="mt-4"
      />

      <EmailComposeDialog
        open={compose !== null}
        onOpenChange={(v) => {
          if (!v) setCompose(null);
        }}
        to={compose?.to ?? ""}
        clientId={compose?.clientId}
      />
    </div>
  );
}

interface RouteInfo {
  miles: number;
  durationText: string | null;
}

function ClientCard({
  c,
  chips,
  baseLocation,
  onEmail,
}: {
  c: ClientRow;
  /** Resolved brand chips (multi-brand PRD §4 Clients) — [] hides them. */
  chips: BrandChipData[];
  baseLocation: string;
  onEmail: (to: string, clientId: string) => void;
}) {
  const [mapOpen, setMapOpen] = useState(false);
  const [route, setRoute] = useState<RouteInfo | null | "loading" | "error">(null);
  const dest = c.address || c.postcode || "";

  // Fetch distance + drive time (base → client) when the map opens. `route` is
  // deliberately NOT a dependency — setting it to "loading" must not re-run + cancel
  // the in-flight fetch.
  useEffect(() => {
    if (!mapOpen || !dest) return;
    let cancelled = false;
    setRoute("loading");
    fetch(`/api/maps/route-to?dest=${encodeURIComponent(dest)}`)
      .then((r) => r.json())
      .then((d: { ok: boolean; miles?: number; durationText?: string | null }) => {
        if (cancelled) return;
        setRoute(d.ok && d.miles != null ? { miles: d.miles, durationText: d.durationText ?? null } : "error");
      })
      .catch(() => !cancelled && setRoute("error"));
    return () => {
      cancelled = true;
    };
  }, [mapOpen, dest]);
  // Classic keyless embed (no API key needed) — directions base → client.
  // Origin anchored to the base POSTCODE: the embed fuzzy-matches house names
  // ("Ash Cottage" exists all over Dorset); a postcode geocodes exactly.
  const origin = baseLocation.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i)?.[0] ?? baseLocation;
  const embedSrc = `https://www.google.com/maps?saddr=${encodeURIComponent(
    origin,
  )}&daddr=${encodeURIComponent(dest)}&output=embed`;
  const externalHref = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    origin,
  )}&destination=${encodeURIComponent(dest)}`;

  // Interactive rows sit above the stretched detail-link (z-10) so a tap on the
  // phone/email/postcode does its own thing, while a tap anywhere else opens the client.
  const rowBase = "relative z-10 -mx-1 flex items-center gap-2 rounded px-1 py-0.5 text-left";

  return (
    <div className="group relative flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-shadow hover:shadow-sm">
      {/* stretched link — the card background opens the client detail */}
      <Link
        href={`/clients/${c.id}`}
        aria-label={`Open ${c.display_name || "client"}`}
        className="focus-ring absolute inset-0 z-0 rounded-lg"
      />

      <div className="relative z-10 flex items-start justify-between gap-3 pointer-events-none">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
            {c.isCompany ? <Building2 className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} /> : null}
            {c.display_name || "Unnamed"}
          </p>
          {/* Wrapper class is conditional so single-brand markup stays exactly
              as today (the single-brand invariant, PRD §1). */}
          <div className={chips.length ? "mt-1.5 flex flex-wrap items-center gap-1.5" : "mt-1.5"}>
            <OriginBadge origin={c.origin} />
            {/* Brand chips under the name beside the OriginBadge (multi-brand
                PRD §4 Clients) — 16px for this tight sub-line, like the leads
                board card. */}
            {chips.map((b) => (
              <BrandChip key={b.slug} brand={b} size={16} />
            ))}
          </div>
        </div>
        {c.leadCount > 1 ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-success-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
            <Repeat className="size-3" strokeWidth={2} />
            {c.leadCount}×
          </span>
        ) : null}
      </div>

      <div className="space-y-1 text-xs text-mist-500">
        {c.phone ? (
          <a href={`tel:${c.phone}`} className={cn(rowBase, "transition-colors hover:bg-muted hover:text-foreground")} title="Call">
            <Phone className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
            <span className="truncate">{c.phone}</span>
          </a>
        ) : (
          <p className="flex items-center gap-2 px-1 py-0.5">
            <Phone className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
            <span className="truncate">—</span>
          </p>
        )}
        {c.email ? (
          <button
            type="button"
            onClick={() => onEmail(c.email!, c.id)}
            className={cn(rowBase, "w-full transition-colors hover:bg-muted hover:text-foreground")}
            title="Email"
          >
            <Mail className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
            <span className="truncate">{c.email}</span>
          </button>
        ) : (
          <p className="flex items-center gap-2 px-1 py-0.5">
            <Mail className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
            <span className="truncate">—</span>
          </p>
        )}
        {dest ? (
          <button
            type="button"
            onClick={() => setMapOpen(true)}
            className={cn(rowBase, "w-full transition-colors hover:bg-muted hover:text-foreground")}
            title="Show route from base"
          >
            <MapPin className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
            <span className="truncate">{c.address || c.postcode}</span>
          </button>
        ) : (
          <p className="flex items-center gap-2 px-1 py-0.5">
            <MapPin className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
            <span className="truncate">—</span>
          </p>
        )}
      </div>

      <div className="relative z-10 mt-auto flex items-center justify-between border-t border-border pt-3 text-xs text-mist-400 pointer-events-none">
        <span>
          {c.leadCount} {c.leadCount === 1 ? "enquiry" : "enquiries"}
        </span>
        <span className="tabular">Last {dateShort(c.lastLeadAt)}</span>
      </div>

      <Dialog open={mapOpen} onOpenChange={setMapOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-display">{c.display_name || "Client"}</DialogTitle>
            <DialogDescription>
              Route from base ({baseLocation}) to {dest}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {route === "loading" ? (
              <span className="text-mist-400">Calculating distance…</span>
            ) : route === "error" || route === null ? (
              <span className="text-mist-400">Distance unavailable</span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-pill bg-mm-red px-2.5 py-1 font-semibold text-white">
                  <Route className="size-4" strokeWidth={2} />
                  {route.miles} miles
                </span>
                {route.durationText ? (
                  <span className="inline-flex items-center gap-1.5 rounded-pill bg-[#eff6ff] px-2.5 py-1 font-semibold text-[#2563eb]">
                    <Clock className="size-4" strokeWidth={2} />
                    {route.durationText}
                  </span>
                ) : null}
                <span className="text-xs text-mist-400">one way, from base</span>
              </>
            )}
          </div>
          <div className="overflow-hidden rounded-md border border-border">
            <iframe
              title={`Route to ${dest}`}
              src={embedSrc}
              className="h-[60vh] max-h-[460px] w-full"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
          <a
            href={externalHref}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex items-center gap-1.5 self-start text-sm font-medium text-mm-red hover:underline"
          >
            <ExternalLink className="size-4" strokeWidth={1.75} />
            Open in Google Maps
          </a>
        </DialogContent>
      </Dialog>
    </div>
  );
}
