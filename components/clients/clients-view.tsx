"use client";

/**
 * Clients directory — the person/household records (the dedupe target). Searchable
 * card grid (3 per row on desktop); each card shows contact, acquisition origin
 * (organic / Google Ads / Meta / referral / manual), enquiry count + last enquiry,
 * and a repeat-customer marker.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, Repeat, Phone, Mail, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SOURCES, type SourceKey } from "@/lib/dashboard/compute";

export interface ClientRow {
  id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  postcode: string | null;
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

export function ClientsView({ clients }: { clients: ClientRow[] }) {
  const [search, setSearch] = useState("");
  const repeat = useMemo(() => clients.filter((c) => c.leadCount > 1).length, [clients]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return clients;
    return clients.filter((c) =>
      [c.display_name, c.email, c.phone, c.postcode].filter(Boolean).some((v) => String(v).toLowerCase().includes(term)),
    );
  }, [clients, search]);

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
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <Link
              key={c.id}
              href={`/clients/${c.id}`}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-shadow hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{c.display_name || "Unnamed"}</p>
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

              <div className="space-y-1.5 text-xs text-mist-500">
                <p className="flex items-center gap-2">
                  <Phone className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
                  <span className="truncate">{c.phone || "—"}</span>
                </p>
                <p className="flex items-center gap-2">
                  <Mail className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
                  <span className="truncate">{c.email || "—"}</span>
                </p>
                <p className="flex items-center gap-2">
                  <MapPin className="size-3.5 shrink-0 text-mist-400" strokeWidth={1.75} />
                  <span className="tabular truncate">{c.postcode || "—"}</span>
                </p>
              </div>

              <div className="mt-auto flex items-center justify-between border-t border-border pt-3 text-xs text-mist-400">
                <span>
                  {c.leadCount} {c.leadCount === 1 ? "enquiry" : "enquiries"}
                </span>
                <span className="tabular">Last {dateShort(c.lastLeadAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
