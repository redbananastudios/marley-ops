"use client";

/**
 * Searchable lead/customer picker for the appointment dialog. A plain dropdown
 * doesn't scale past a handful of leads, so this filters as you type across name,
 * phone, postcode and email. Keyboard-free, tap-friendly for the iPad.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { LeadOption } from "./appointment-dialog";

const NO_LEAD = "__none__";
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, "");

export function LeadCombobox({
  leads,
  value,
  onChange,
  noLeadLabel = "No lead (blocked time)",
}: {
  leads: LeadOption[];
  value: string;
  onChange: (id: string) => void;
  noLeadLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const selected = value === NO_LEAD ? null : leads.find((l) => l.id === value) ?? null;

  const filtered = useMemo(() => {
    const t = norm(term);
    if (!t) return leads.slice(0, 60);
    return leads
      .filter((l) => {
        const hay = norm([l.name, l.phone, l.email, l.from_postcode, l.from_address].filter(Boolean).join(" "));
        return hay.includes(t);
      })
      .slice(0, 60);
  }, [leads, term]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(id: string) {
    onChange(id);
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
          {selected ? selected.name || "Unnamed lead" : noLeadLabel}
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
              placeholder="Search name, phone, postcode, email"
              className="h-9 pl-8"
              aria-label="Search leads"
            />
          </div>
          <ul role="listbox" className="max-h-64 overflow-auto py-1">
            <li>
              <button
                type="button"
                onClick={() => pick(NO_LEAD)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span className="text-mist-500">{noLeadLabel}</span>
                {value === NO_LEAD ? <Check className="size-4 text-mm-red" strokeWidth={2} /> : null}
              </button>
            </li>
            {filtered.map((l) => {
              const sub = [
                l.isClient ? "client — opens a new enquiry" : null,
                l.from_postcode,
                l.phone,
                l.email,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => pick(l.id)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">{l.name || "Unnamed lead"}</span>
                      {sub ? <span className="block truncate text-xs text-mist-400">{sub}</span> : null}
                    </span>
                    {value === l.id ? <Check className="size-4 shrink-0 text-mm-red" strokeWidth={2} /> : null}
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
