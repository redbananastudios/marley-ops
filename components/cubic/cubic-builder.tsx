"use client";

/**
 * Cubic survey builder — tablet-first (Peter, 2026-07-10: "design this from a
 * tablet use first perspective… clearer to see what's been calculated").
 *
 * The three things iMVE gets wrong, fixed by construction:
 *  1. A STICKY total bar — total ft³ + van recommendation + fill bar update on
 *     every tap, always visible.
 *  2. One-tap add: tap an item card to add it; the qty stepper appears on the
 *     card itself. Search-first across every category.
 *  3. The added list shows per-category subtotals, per-line editable ft³ and
 *     the flags a surveyor actually needs (dismantle / fragile / not moving).
 *
 * Office mode autosaves (debounced, flushed on unmount/hide) and can "Mark
 * complete"; customer mode (/cv/<token>) hides internal controls, keeps a
 * localStorage draft, and submits once. Saves carry the row's updated_at —
 * a stale tab gets a reload banner instead of silently clobbering (review,
 * 2026-07-10). Totals here are display-only; the server recomputes.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Camera,
  Check,
  CheckCircle2,
  Loader2,
  Minus,
  Package,
  Plus,
  RefreshCw,
  Search,
  Truck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CUBIC_CATEGORIES, CUBIC_CATEGORY_TITLES, type CubicCatalogueItem } from "@/lib/cubic-catalogue";
import {
  computeCubicTotals,
  recommendVans,
  vehicleShortLabel,
  type CubicLine,
  type VanCapacities,
} from "@/lib/cubic-survey";
import { SurveyPhotos } from "@/components/quote/survey-photos";

export type CubicSaveResult =
  | { ok: true; totalFt3: number; updatedAt: string }
  | { ok: false; error: string; conflict?: boolean };

export interface CubicBuilderProps {
  mode: "office" | "customer";
  customerName: string;
  initialLines: CubicLine[];
  initialNotes: string;
  initialStatus: string;
  /** Row updated_at at load time — the optimistic-concurrency token. */
  initialUpdatedAt: string;
  capacities: VanCapacities;
  /** Bound server action: (payload) => result. */
  save: (payload: {
    items: CubicLine[];
    notes: string;
    status?: "draft" | "complete";
    baseUpdatedAt: string;
  }) => Promise<CubicSaveResult>;
  /** Office extras */
  leadId?: string;
  /** What the customer wrote via /cv — shown read-only to the office. */
  customerNotes?: string;
  /** Customer mode: localStorage key for the pre-submit draft. */
  draftKey?: string;
}

const CUSTOM_CATEGORY = "custom";

export function CubicBuilder({
  mode,
  customerName,
  initialLines,
  initialNotes,
  initialStatus,
  initialUpdatedAt,
  capacities,
  save,
  leadId,
  customerNotes,
  draftKey,
}: CubicBuilderProps) {
  const office = mode === "office";
  const [lines, setLines] = useState<CubicLine[]>(initialLines);
  const [notes, setNotes] = useState(initialNotes);
  const [status, setStatus] = useState(initialStatus);
  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState(CUBIC_CATEGORIES[0].key);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [conflict, setConflict] = useState(false);
  const [completing, startCompleting] = useTransition();
  const [submitted, setSubmitted] = useState(false);

  const totals = useMemo(() => computeCubicTotals(lines), [lines]);
  const rec = useMemo(() => recommendVans(totals.totalFt3, capacities), [totals.totalFt3, capacities]);
  const qtyByKey = useMemo(() => new Map(lines.map((l) => [l.key, l.qty])), [lines]);

  /* ---------------- mutations ---------------- */

  const addCatalogueItem = useCallback((item: CubicCatalogueItem, category: string) => {
    setLines((prev) => {
      const hit = prev.find((l) => l.key === item.key);
      if (hit) return prev.map((l) => (l.key === item.key ? { ...l, qty: Math.min(999, l.qty + 1) } : l));
      return [...prev, { key: item.key, title: item.title, category, qty: 1, unitFt3: item.ft3, flags: {} }];
    });
  }, []);

  const bump = useCallback((key: string, delta: number) => {
    setLines((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, qty: Math.min(999, l.qty + delta) } : l))
        .filter((l) => l.qty > 0),
    );
  }, []);

  const setUnit = useCallback((key: string, unitFt3: number) => {
    const rounded = Math.round(Math.max(0, Math.min(2000, unitFt3)) * 10) / 10;
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, unitFt3: rounded } : l)));
  }, []);

  const toggleFlag = useCallback((key: string, flag: "dismantle" | "fragile" | "notMoving") => {
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, flags: { ...l.flags, [flag]: !l.flags?.[flag] } } : l)),
    );
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }, []);

  const addCustom = useCallback((title: string, ft3: number, qty: number, category: string) => {
    setLines((prev) => [
      ...prev,
      { key: `custom:${crypto.randomUUID()}`, title, category, qty, unitFt3: ft3, flags: {} },
    ]);
  }, []);

  /* ---------------- customer draft (localStorage, pre-submit safety net) */

  useEffect(() => {
    if (office || !draftKey) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as { lines?: CubicLine[]; notes?: string };
      if (Array.isArray(d.lines) && d.lines.length) {
        setLines(d.lines);
        if (typeof d.notes === "string") setNotes(d.notes);
        toast.info("Restored your unsent list from this device.");
      }
    } catch {
      /* corrupt draft — ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (office || !draftKey || submitted) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ lines, notes }));
    } catch {
      /* storage full/blocked — non-fatal */
    }
  }, [office, draftKey, lines, notes, submitted]);

  /* ---------------- persistence (office autosave + flush) ---------------- */

  const baseUpdatedAt = useRef(initialUpdatedAt);
  const latest = useRef({ lines, notes });
  latest.current = { lines, notes };
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSave = useCallback(
    async (status?: "draft" | "complete") => {
      const payload = {
        items: latest.current.lines,
        notes: latest.current.notes,
        ...(status ? { status } : {}),
        baseUpdatedAt: baseUpdatedAt.current,
      };
      const res = await save(payload);
      if (res.ok) {
        baseUpdatedAt.current = res.updatedAt;
        dirty.current = false;
      } else if (res.conflict) {
        setConflict(true);
      }
      return res;
    },
    [save],
  );

  const first = useRef(true);
  useEffect(() => {
    if (!office) return;
    if (first.current) {
      first.current = false;
      return;
    }
    if (conflict) return; // stop writing over someone else — reload first
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      const res = await runSave();
      setSaveState(res.ok ? "saved" : "idle");
      if (!res.ok && !res.conflict) toast.error(res.error);
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, notes]);

  // Flush pending edits when the tab hides or the component unmounts —
  // a debounce alone loses the last 1.2s of taps on back-navigation.
  useEffect(() => {
    if (!office) return;
    const flush = () => {
      if (!dirty.current || conflict) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void runSave();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [office, conflict, runSave]);

  const markComplete = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current); // no trailing autosave after completing
    startCompleting(async () => {
      const res = await runSave("complete");
      if (!res.ok) {
        if (!res.conflict) toast.error(res.error);
        return;
      }
      setStatus("complete");
      setSaveState("saved");
      toast.success(`Survey complete — ${res.totalFt3} ft³ recorded.`);
    });
  }, [runSave]);

  const submitCustomer = useCallback(() => {
    if (lines.length === 0) {
      toast.error("Add at least one item first.");
      return;
    }
    startCompleting(async () => {
      const res = await runSave();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (draftKey) {
        try {
          localStorage.removeItem(draftKey);
        } catch {
          /* non-fatal */
        }
      }
      setSubmitted(true);
    });
  }, [lines.length, runSave, draftKey]);

  /* ---------------- catalogue view ---------------- */

  const searchTerm = search.trim().toLowerCase();
  const visible: { category: string; item: CubicCatalogueItem }[] = useMemo(() => {
    if (searchTerm) {
      const out: { category: string; item: CubicCatalogueItem }[] = [];
      for (const c of CUBIC_CATEGORIES)
        for (const i of c.items) if (i.title.toLowerCase().includes(searchTerm)) out.push({ category: c.key, item: i });
      return out;
    }
    const cat = CUBIC_CATEGORIES.find((c) => c.key === activeCat) ?? CUBIC_CATEGORIES[0];
    return cat.items.map((item) => ({ category: cat.key, item }));
  }, [searchTerm, activeCat]);

  /* ---------------- grouped added list ---------------- */

  const grouped = useMemo(() => {
    const order = [...CUBIC_CATEGORIES.map((c) => c.key), CUSTOM_CATEGORY];
    const map = new Map<string, CubicLine[]>();
    for (const l of lines) {
      const g = map.get(l.category) ?? [];
      g.push(l);
      map.set(l.category, g);
    }
    return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [lines]);

  if (submitted) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-success-border bg-success-bg p-8 text-center">
        <CheckCircle2 className="mx-auto size-10 text-success" strokeWidth={1.5} />
        <h2 className="mt-3 font-display text-2xl font-semibold text-foreground">Sent — thank you.</h2>
        <p className="mt-2 text-sm text-mist-500">
          We&apos;ve got your list ({totals.itemCount} items). We&apos;ll use it to size the right van and crew for
          your move — any questions, call 01747 637070.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* conflict banner — another writer won; stop and reload */}
      {conflict ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-warn-border bg-warn-bg p-4">
          <p className="text-sm font-semibold text-warn">
            This survey changed elsewhere (another device, or the customer submitted their list). Reload to carry on —
            unsaved taps here are held until then.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="focus-ring ml-auto inline-flex min-h-11 items-center gap-2 rounded-md bg-warn px-4 text-sm font-semibold text-white"
          >
            <RefreshCw className="size-4" strokeWidth={2} />
            Reload
          </button>
        </div>
      ) : null}

      {/* ============ STICKY CALCULATION BAR ============ */}
      {/* top-14: sits below the 56px mobile-nav header; md+ has no header. */}
      <div className="sticky top-14 z-20 -mx-5 border-b bg-card/95 px-5 py-3 backdrop-blur md:top-0 md:-mx-8 md:px-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-baseline gap-2">
            <span className="tabular font-display text-3xl font-bold text-foreground">
              {totals.totalFt3.toLocaleString("en-GB")}
            </span>
            <span className="text-sm font-semibold text-mist-500">ft³</span>
            <span className="tabular text-xs text-mist-400">
              {totals.totalM3} m³ · {totals.itemCount} item{totals.itemCount === 1 ? "" : "s"}
            </span>
          </div>

          {rec ? (
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-mm-red-tint px-3 py-1 text-sm font-semibold text-mm-red-deep">
                <Truck className="size-4" strokeWidth={2} />
                {vehicleShortLabel(rec)}
                {rec.consider75t ? (
                  <span className="font-normal">· or {rec.sevenFiveTLoads} × 7.5t</span>
                ) : null}
              </span>
              <div className="hidden min-w-28 max-w-44 flex-1 sm:block">
                <div className="h-2 overflow-hidden rounded-pill bg-mist-100">
                  <div
                    className={cn("h-full rounded-pill", rec.fillOfRecommendationPct > 100 ? "bg-warn" : "bg-mm-red")}
                    style={{ width: `${Math.min(100, rec.fillOfRecommendationPct)}%` }}
                  />
                </div>
                <p className="mt-0.5 text-[10px] leading-none text-mist-400">
                  {rec.fillOfRecommendationPct}% of {vehicleShortLabel(rec)} at {capacities.fillPct}% fill
                </p>
              </div>
            </div>
          ) : (
            <span className="text-sm text-mist-400">Tap items to build the volume — the van maths appears here.</span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {office ? (
              <>
                <span className="text-xs text-mist-400">
                  {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
                </span>
                {status === "complete" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-pill bg-success-bg px-3 py-1 text-xs font-semibold uppercase tracking-wide text-success">
                    <Check className="size-3.5" strokeWidth={2.5} /> Complete
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={markComplete}
                    disabled={completing || conflict || lines.length === 0}
                    className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md bg-mm-red px-4 text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-50"
                  >
                    {completing ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : null}
                    Mark complete
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={submitCustomer}
                disabled={completing}
                className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-md bg-mm-red px-5 text-sm font-semibold text-white hover:bg-mm-red-deep disabled:opacity-50"
              >
                {completing ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : null}
                Send to Marley Moves
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ============ TWO-PANE LAYOUT ============ */}
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* ---------- picker ---------- */}
        <div className="min-w-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-mist-400" strokeWidth={1.75} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search everything — sofa, piano, boxes…"
              className="focus-ring w-full rounded-md border border-input bg-card pl-11 pr-10 text-base text-foreground placeholder:text-mist-400"
              style={{ height: 52 }}
            />
            {search ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-mist-400 hover:bg-muted"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            ) : null}
          </div>

          {!searchTerm ? (
            <div className="scrollbar-none -mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1">
              {CUBIC_CATEGORIES.map((c) => {
                const catQty = lines.filter((l) => l.category === c.key && !l.flags?.notMoving).reduce((s, l) => s + l.qty, 0);
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setActiveCat(c.key)}
                    className={cn(
                      "focus-ring flex min-h-11 shrink-0 items-center gap-2 rounded-pill border px-4 text-sm font-medium",
                      activeCat === c.key
                        ? "border-mm-red bg-mm-red-tint text-mm-red-deep"
                        : "border-input bg-card text-foreground hover:bg-muted",
                    )}
                  >
                    {c.title}
                    {catQty > 0 ? (
                      <span className="tabular rounded-pill bg-mm-red px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                        {catQty}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="mt-3 text-xs text-mist-400">
              {visible.length} match{visible.length === 1 ? "" : "es"} across all rooms
            </p>
          )}

          {/* item grid — tap card = first add; steppers own it after that
              (a near-miss on − must never read as +1: review, 2026-07-10) */}
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
            {visible.map(({ category, item }) => {
              const qty = qtyByKey.get(item.key) ?? 0;
              const addFirst = () => {
                if ((qtyByKey.get(item.key) ?? 0) === 0) addCatalogueItem(item, category);
              };
              return (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  aria-label={qty === 0 ? `Add ${item.title}` : `${item.title}, quantity ${qty}`}
                  onClick={addFirst}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return; // steppers handle their own keys
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      addFirst();
                    }
                  }}
                  className={cn(
                    "focus-ring flex min-h-20 select-none flex-col justify-between rounded-md border p-3 text-left transition",
                    qty > 0
                      ? "border-mm-red bg-mm-red-tint/40"
                      : "cursor-pointer border-border bg-card hover:bg-muted active:scale-[0.98]",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-snug text-foreground">{item.title}</span>
                    <span className="tabular shrink-0 rounded-pill bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-mist-500">
                      {item.ft3} ft³
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    {searchTerm ? (
                      <span className="truncate text-[10px] uppercase tracking-wide text-mist-400">
                        {CUBIC_CATEGORY_TITLES[category]}
                      </span>
                    ) : (
                      <span />
                    )}
                    {qty > 0 ? (
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          aria-label={`Remove one ${item.title}`}
                          onClick={() => bump(item.key, -1)}
                          className="focus-ring flex size-11 items-center justify-center rounded-md border border-input bg-card text-foreground hover:bg-muted"
                        >
                          <Minus className="size-4" strokeWidth={2} />
                        </button>
                        <span className="tabular w-8 text-center text-base font-bold text-foreground">{qty}</span>
                        <button
                          type="button"
                          aria-label={`Add one ${item.title}`}
                          onClick={() => bump(item.key, 1)}
                          className="focus-ring flex size-11 items-center justify-center rounded-md bg-mm-red text-white hover:bg-mm-red-deep"
                        >
                          <Plus className="size-4" strokeWidth={2} />
                        </button>
                      </div>
                    ) : (
                      <Plus className="size-4 text-mist-300" strokeWidth={2} />
                    )}
                  </div>
                </div>
              );
            })}
            {visible.length === 0 ? (
              <p className="col-span-full py-8 text-center text-sm text-mist-400">
                Nothing matches — add it as a custom item in the &quot;What&apos;s moving&quot; list.
              </p>
            ) : null}
          </div>
        </div>

        {/* ---------- added list ---------- */}
        <div className="min-w-0">
          <div className="rounded-lg border border-border bg-card lg:sticky lg:top-20">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <p className="eyebrow flex items-center gap-1.5">
                <Package className="size-3.5" strokeWidth={1.75} /> What&apos;s moving
              </p>
              <span className="tabular text-xs text-mist-400">
                {totals.itemCount} item{totals.itemCount === 1 ? "" : "s"}
              </span>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {grouped.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-mist-400">
                  Nothing added yet — tap items to build the list.
                </p>
              ) : (
                grouped.map(([cat, catLines]) => {
                  const catFt3 = catLines
                    .filter((l) => !l.flags?.notMoving)
                    .reduce((s, l) => s + l.qty * l.unitFt3, 0);
                  return (
                    <div key={cat} className="border-b last:border-b-0">
                      <div className="flex items-baseline justify-between bg-muted/60 px-4 py-1.5">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-mist-500">
                          {CUBIC_CATEGORY_TITLES[cat] ?? "Custom items"}
                        </span>
                        <span className="tabular text-[11px] font-semibold text-mist-500">
                          {Math.round(catFt3 * 10) / 10} ft³
                        </span>
                      </div>
                      <ul className="divide-y">
                        {catLines.map((l) => (
                          <li key={l.key} className={cn("px-4 py-2.5", l.flags?.notMoving && "opacity-55")}>
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate text-sm font-medium text-foreground">{l.title}</span>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  aria-label={`Remove one ${l.title}`}
                                  onClick={() => bump(l.key, -1)}
                                  className="focus-ring flex size-11 items-center justify-center rounded-md border border-input text-foreground hover:bg-muted"
                                >
                                  <Minus className="size-4" strokeWidth={2} />
                                </button>
                                <span className="tabular w-7 text-center text-sm font-bold text-foreground">{l.qty}</span>
                                <button
                                  type="button"
                                  aria-label={`Add one ${l.title}`}
                                  onClick={() => bump(l.key, 1)}
                                  className="focus-ring flex size-11 items-center justify-center rounded-md border border-input text-foreground hover:bg-muted"
                                >
                                  <Plus className="size-4" strokeWidth={2} />
                                </button>
                              </div>
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {office ? (
                                <label className="flex items-center gap-1 text-[11px] text-mist-400">
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min={0}
                                    max={2000}
                                    step="0.1"
                                    value={l.unitFt3 === 0 ? "" : l.unitFt3}
                                    placeholder="0"
                                    onChange={(e) =>
                                      setUnit(l.key, e.target.value === "" ? 0 : Number(e.target.value) || 0)
                                    }
                                    className="focus-ring tabular h-11 w-20 rounded-md border border-input bg-card px-1.5 text-center text-base text-foreground"
                                  />
                                  ft³ each
                                </label>
                              ) : (
                                <span className="tabular text-[11px] text-mist-400">{l.unitFt3} ft³ each</span>
                              )}
                              <span className="tabular ml-auto text-xs font-semibold text-foreground">
                                {l.flags?.notMoving ? "—" : `${Math.round(l.qty * l.unitFt3 * 10) / 10} ft³`}
                              </span>
                            </div>
                            {office ? (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {(
                                  [
                                    ["dismantle", "Dismantle"],
                                    ["fragile", "Fragile"],
                                    ["notMoving", "Not moving"],
                                  ] as const
                                ).map(([flag, label]) => (
                                  <button
                                    key={flag}
                                    type="button"
                                    onClick={() => toggleFlag(l.key, flag)}
                                    className={cn(
                                      "focus-ring min-h-11 rounded-pill border px-3 text-xs font-medium",
                                      l.flags?.[flag]
                                        ? flag === "notMoving"
                                          ? "border-mist-400 bg-mist-100 text-mist-500"
                                          : "border-warn-border bg-warn-bg text-warn"
                                        : "border-input bg-card text-mist-400 hover:bg-muted",
                                    )}
                                  >
                                    {label}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  onClick={() => removeLine(l.key)}
                                  className="focus-ring ml-auto min-h-11 rounded-pill px-2.5 text-xs text-mist-400 hover:text-mm-red"
                                >
                                  Remove
                                </button>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>

            <CustomItemRow onAdd={(t, f, q) => addCustom(t, f, q, searchTerm ? CUSTOM_CATEGORY : activeCat)} office={office} />
          </div>
        </div>
      </div>

      {/* ---------- photos + notes (full width, AFTER the list on portrait) ---------- */}
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {office && leadId ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="eyebrow mb-3 flex items-center gap-1.5">
              <Camera className="size-3.5" strokeWidth={1.75} /> Survey photos
            </p>
            <SurveyPhotos leadId={leadId} category="cubic" label="Volume survey" />
          </div>
        ) : null}
        <div className="rounded-lg border border-border bg-card p-4">
          <label htmlFor="cubic-notes" className="eyebrow mb-2 block">
            {office ? "Survey notes (internal — never shown to the customer)" : "Anything else we should know?"}
          </label>
          <textarea
            id="cubic-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder={
              office
                ? "Access quirks, items to confirm, anything the quote should reflect…"
                : "Awkward access, items you're unsure about, anything else…"
            }
            className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2.5 text-base text-foreground placeholder:text-mist-400 md:text-sm"
          />
          {office && customerNotes?.trim() ? (
            <div className="mt-3 rounded-md border-l-4 border-mm-red bg-muted/60 p-3">
              <p className="eyebrow mb-1">What the customer wrote</p>
              <p className="whitespace-pre-wrap text-sm text-foreground">{customerNotes.trim()}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------------- custom item inline form ---------------- */

function CustomItemRow({ onAdd, office }: { onAdd: (title: string, ft3: number, qty: number) => void; office: boolean }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [ft3, setFt3] = useState("");
  const [qty, setQty] = useState("1");

  const submit = () => {
    const t = title.trim();
    const f = Number(ft3);
    const q = Math.max(1, Math.floor(Number(qty) || 1));
    if (t.length < 2) {
      toast.error("Name the item first.");
      return;
    }
    if (!Number.isFinite(f) || f < 0 || f > 2000) {
      toast.error("Give it a cubic-feet value (0–2000).");
      return;
    }
    onAdd(t, Math.round(f * 10) / 10, q);
    setTitle("");
    setFt3("");
    setQty("1");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring flex min-h-12 w-full items-center justify-center gap-2 border-t text-sm font-medium text-mm-red hover:bg-mm-red-tint/40"
      >
        <Plus className="size-4" strokeWidth={2} />
        Custom item
      </button>
    );
  }
  return (
    <div className="space-y-2 border-t p-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={office ? "Item name — e.g. Harp" : "Item name"}
        maxLength={120}
        autoFocus
        className="focus-ring h-11 w-full rounded-md border border-input bg-card px-3 text-base text-foreground placeholder:text-mist-400"
      />
      <div className="flex items-center gap-2">
        <input
          value={ft3}
          onChange={(e) => setFt3(e.target.value)}
          type="number"
          inputMode="decimal"
          min={0}
          max={2000}
          placeholder="ft³ each"
          className="focus-ring tabular h-11 w-24 rounded-md border border-input bg-card px-2 text-center text-base text-foreground placeholder:text-mist-400"
        />
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          type="number"
          inputMode="numeric"
          min={1}
          max={999}
          className="focus-ring tabular h-11 w-16 rounded-md border border-input bg-card px-2 text-center text-base text-foreground"
        />
        <button
          type="button"
          onClick={submit}
          className="focus-ring ml-auto inline-flex min-h-11 items-center rounded-md bg-mm-red px-4 text-sm font-semibold text-white hover:bg-mm-red-deep"
        >
          Add
        </button>
        <button
          type="button"
          aria-label="Cancel custom item"
          onClick={() => setOpen(false)}
          className="focus-ring flex size-11 items-center justify-center rounded-md text-mist-400 hover:bg-muted"
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      {office ? (
        <p className="text-[11px] text-mist-400">Rough guide: a washing machine is 13 ft³, a wardrobe 40 ft³.</p>
      ) : null}
    </div>
  );
}
