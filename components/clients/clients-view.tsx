"use client";

/**
 * Clients directory — the person/household records (the dedupe target). Searchable
 * list; each row shows contact + how many enquiries they've made + last enquiry,
 * and a repeat-customer marker. Responsive: rows on desktop, cards on mobile.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export interface ClientRow {
  id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  leadCount: number;
  lastLeadAt: string | null;
}

function dateShort(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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

      <ul className="mt-4 divide-y rounded-lg border border-border bg-card">
        {visible.length === 0 ? (
          <li className="px-5 py-12 text-center text-sm text-mist-400">No clients match.</li>
        ) : (
          visible.map((c) => (
            <li key={c.id}>
              <Link
                href={`/clients/${c.id}`}
                className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/60 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
              >
                <span className="min-w-0 sm:flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{c.display_name || "Unnamed"}</span>
                    {c.leadCount > 1 ? (
                      <span className="inline-flex items-center gap-1 rounded-pill bg-mm-red-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mm-red-deep">
                        <Repeat className="size-3" strokeWidth={2} />
                        {c.leadCount}×
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-mist-400">
                    {[c.phone, c.email].filter(Boolean).join(" · ") || "no contact"}
                  </span>
                </span>
                <span className="flex items-center gap-4 text-xs text-mist-400 sm:gap-6">
                  {c.postcode ? <span className="tabular">{c.postcode}</span> : null}
                  <span className="tabular w-28 shrink-0 sm:text-right">{dateShort(c.lastLeadAt)}</span>
                </span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
