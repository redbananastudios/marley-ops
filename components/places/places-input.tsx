"use client";

/**
 * Address / postcode input with Google Places autocomplete, fed by the server-side
 * /api/places proxy (key never reaches the browser). Controlled: bind `value` +
 * `onValueChange`. `kind="address"` inserts the full formatted address on select;
 * `kind="postcode"` inserts just the postcode. Degrades to a plain text field if
 * Places is unavailable. Keyboard: ↑/↓ to move, Enter to pick, Esc to dismiss.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Prediction {
  id: string;
  description: string;
  main: string;
  secondary: string;
}

export function PlacesInput({
  value,
  onValueChange,
  kind = "address",
  id,
  placeholder,
  className,
  inputMode,
}: {
  value: string;
  onValueChange: (v: string) => void;
  kind?: "address" | "postcode";
  id?: string;
  placeholder?: string;
  className?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  const [items, setItems] = useState<Prediction[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  // Suppress the fetch fired by our own onValueChange after a pick.
  const skipNext = useRef(false);
  // Only search after a real keystroke — never auto-open on a prefilled value
  // (robust against React StrictMode's double-mount in dev).
  const dirty = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  // Debounced lookup as the user types.
  useEffect(() => {
    if (!dirty.current) return;
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 3) {
      setItems([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/places?q=${encodeURIComponent(q)}&kind=${kind}`, {
          signal: AbortSignal.timeout(5000),
        });
        const json = (await res.json()) as { predictions?: Prediction[] };
        if (cancelled) return;
        setItems(json.predictions ?? []);
        setOpen((json.predictions ?? []).length > 0);
        setActive(-1);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value, kind]);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(p: Prediction) {
    skipNext.current = true;
    onValueChange(kind === "postcode" ? p.main : p.description);
    setItems([]);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          dirty.current = true;
          onValueChange(e.target.value);
        }}
        onFocus={() => items.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={className}
        inputMode={inputMode}
        name={`pl-${listId}`}
        autoComplete={`pl-${listId}`}
        data-1p-ignore
        data-lpignore="true"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
      />
      {loading ? (
        <Loader2 className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-mist-400" strokeWidth={1.75} />
      ) : null}

      {open && items.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
        >
          {items.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-2 text-left text-sm",
                  i === active ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <MapPin className="mt-0.5 size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">{p.main}</span>
                  {p.secondary ? <span className="block truncate text-xs text-mist-400">{p.secondary}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
