"use client";

/**
 * Clients directory — the person/household records (the dedupe target). Searchable
 * card grid (3 per row on desktop); each card shows contact, acquisition origin
 * (organic / Google Ads / Meta / referral / manual), enquiry count + last enquiry,
 * and a repeat-customer marker.
 */

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Search, Repeat, Phone, Mail, MapPin, Building2, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export function ClientsView({ clients, baseLocation }: { clients: ClientRow[]; baseLocation: string }) {
  const [search, setSearch] = useState("");
  const repeat = useMemo(() => clients.filter((c) => c.leadCount > 1).length, [clients]);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = term
      ? clients.filter((c) =>
          [c.display_name, c.email, c.phone, c.postcode, c.address]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(term)),
        )
      : clients;
    // Alphabetical by name, case-insensitive, unnamed/non-alpha last.
    return [...filtered].sort((a, b) =>
      (a.display_name || "￿").localeCompare(b.display_name || "￿", "en-GB", { sensitivity: "base" }),
    );
  }, [clients, search]);

  // Group the sorted list into A–Z (then "#") sections for the index rail.
  const groups = useMemo(() => {
    const map = new Map<string, ClientRow[]>();
    for (const c of visible) {
      const k = letterOf(c.display_name);
      (map.get(k) ?? map.set(k, []).get(k)!).push(c);
    }
    return ALPHABET.filter((l) => map.has(l)).map((l) => ({ letter: l, rows: map.get(l)! }));
  }, [visible]);

  const present = useMemo(() => new Set(groups.map((g) => g.letter)), [groups]);

  function jumpTo(letter: string) {
    sectionRefs.current[letter]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mist-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, email, postcode" className="pl-9" aria-label="Search clients" />
        </div>
        <span className="text-xs text-mist-400">
          {clients.length} clients{repeat > 0 ? ` · ${repeat} repeat` : ""}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 rounded-lg border border-border bg-card px-5 py-12 text-center text-sm text-mist-400">
          No clients match.
        </div>
      ) : (
        <div className="mt-4 flex gap-3">
          {/* sectioned, alphabetised list */}
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
                    <ClientCard key={c.id} c={c} baseLocation={baseLocation} />
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
      )}
    </div>
  );
}

function ClientCard({ c, baseLocation }: { c: ClientRow; baseLocation: string }) {
  const [mapOpen, setMapOpen] = useState(false);
  const dest = c.address || c.postcode || "";
  // Classic keyless embed (no API key needed) — directions base → client.
  const embedSrc = `https://www.google.com/maps?saddr=${encodeURIComponent(
    baseLocation,
  )}&daddr=${encodeURIComponent(dest)}&output=embed`;
  const externalHref = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
    baseLocation,
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
          <div className="mt-1.5">
            <OriginBadge origin={c.origin} />
          </div>
        </div>
        {c.leadCount > 1 ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-mm-red-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mm-red-deep">
            <Repeat className="size-3" strokeWidth={2} />
            {c.leadCount}×
          </span>
        ) : null}
      </div>

      <div className="space-y-1 text-xs text-mist-500">
        {c.phone ? (
          <a href={`tel:${c.phone}`} className={cn(rowBase, "transition-colors hover:bg-muted hover:text-[#db2777]")} title="Call">
            <Phone className="size-3.5 shrink-0 text-[#db2777]" strokeWidth={1.75} />
            <span className="truncate">{c.phone}</span>
          </a>
        ) : (
          <p className="flex items-center gap-2 px-1 py-0.5">
            <Phone className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
            <span className="truncate">—</span>
          </p>
        )}
        {c.email ? (
          <a href={`mailto:${c.email}`} className={cn(rowBase, "transition-colors hover:bg-muted hover:text-[#2563eb]")} title="Email">
            <Mail className="size-3.5 shrink-0 text-[#2563eb]" strokeWidth={1.75} />
            <span className="truncate">{c.email}</span>
          </a>
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
            className={cn(rowBase, "w-full transition-colors hover:bg-muted hover:text-mm-red")}
            title="Show route from base"
          >
            <MapPin className="size-3.5 shrink-0 text-mm-red" strokeWidth={1.75} />
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
