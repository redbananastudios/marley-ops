"use client";

/**
 * Searchable existing-customer picker (mirrors the appointment LeadCombobox).
 * Filters as you type across name, phone, email and postcode, with a "New customer"
 * row at the top. Selecting a client attaches the new lead to them and pre-fills
 * their contact details; "New customer" leaves the form blank for a fresh record.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export interface ClientOption {
  id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  postcode: string | null;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, "");

export function ClientCombobox({
  clients,
  value,
  onChange,
}: {
  clients: ClientOption[];
  /** selected client id, or null for "New customer" */
  value: string | null;
  onChange: (client: ClientOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const selected = value ? clients.find((c) => c.id === value) ?? null : null;

  const filtered = useMemo(() => {
    const t = norm(term);
    if (!t) return clients.slice(0, 60);
    return clients
      .filter((c) => norm([c.display_name, c.phone, c.email, c.postcode].filter(Boolean).join(" ")).includes(t))
      .slice(0, 60);
  }, [clients, term]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(c: ClientOption | null) {
    onChange(c);
    setOpen(false);
    setTerm("");
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="focus-ring flex h-11 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm"
      >
        <span className={cn("truncate", !selected && "text-mist-400")}>
          {selected ? selected.display_name || "Unnamed customer" : "New customer"}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
      </button>

      {open ? (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <div className="relative border-b p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-mist-400" strokeWidth={1.75} />
            <Input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search name, phone, email, postcode"
              className="h-9 pl-8"
              aria-label="Search customers"
            />
          </div>
          <ul role="listbox" className="max-h-64 overflow-auto py-1">
            <li>
              <button
                type="button"
                onClick={() => pick(null)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span className="inline-flex items-center gap-2 font-medium text-mm-red">
                  <UserPlus className="size-4" strokeWidth={1.75} />
                  New customer
                </span>
                {value === null ? <Check className="size-4 text-mm-red" strokeWidth={2} /> : null}
              </button>
            </li>
            {filtered.map((c) => {
              const sub = [c.postcode, c.phone, c.email].filter(Boolean).join(" · ");
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => pick(c)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">{c.display_name || "Unnamed customer"}</span>
                      {sub ? <span className="block truncate text-xs text-mist-400">{sub}</span> : null}
                    </span>
                    {value === c.id ? <Check className="size-4 shrink-0 text-mm-red" strokeWidth={2} /> : null}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-mist-400">No matches</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
