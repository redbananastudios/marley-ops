"use client";

/**
 * The 7 step bodies for the quote builder wizard. Ported from the live MM Quotes
 * tool (quotes-app/public/index.html wizard, ~L1407-1822) into React + the Marley
 * Ops design tokens. Each step is a controlled component over a slice of
 * QuoteFormValues. iPad-friendly: 56px inputs, large segmented controls, 44px
 * steppers, red focus, no hover-only affordances.
 */

import { useState } from "react";
import Link from "next/link";
import { Minus, Plus, Loader2, MapPin, Boxes } from "lucide-react";
import { cn } from "@/lib/utils";
import { AddressFields, type AddressValue } from "@/components/places/address-fields";
import {
  BASE_PRICES,
  PACK_PRICES,
  ADDON_75T_BASE,
  ADDON_TRANSIT_BASE,
  VEHICLE_KEYS,
  VAN_COUNT,
  type VehicleKey,
  type PackingKey,
  type FloorKey,
  type PropertyType,
} from "@/lib/quote/constants";
import {
  ITEM_FIELDS,
  composeAddr,
  BLANK_QUOTE_ADDRESS,
  type ItemGroup,
  type QuoteFormValues,
  type QuoteItems,
  type RouteLeg,
} from "@/lib/quote/form-types";
import type { PricingConfig, QuoteBreakdown } from "@/lib/quote/pricing";
import { jobCost, marginPct, boxesFromItems } from "@/lib/margin";
import type { BusinessSettings } from "@/lib/settings";
import { SurveyPhotos } from "@/components/quote/survey-photos";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" +
      Number(n)
        .toFixed(2)
        .replace(/\.00$/, "")
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/* ---------- shared field primitives (56px Marley field styling) ---------- */

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="mb-2 block text-sm font-semibold text-foreground">
      {children}
      {required ? <span className="ml-0.5 text-mm-red">*</span> : null}
    </label>
  );
}

function TextField({
  label,
  required,
  help,
  error,
  ...props
}: {
  label: string;
  required?: boolean;
  help?: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="mb-5">
      <FieldLabel required={required}>{label}</FieldLabel>
      <input
        {...props}
        aria-invalid={error ? true : undefined}
        className={cn(
          "h-14 w-full rounded-md border bg-card px-4 text-base text-foreground",
          "placeholder:text-mist-300 focus:outline-none focus:ring-2 focus:border-mm-red focus:ring-mm-red/30",
          error ? "border-mm-red" : "border-input",
          props.className,
        )}
      />
      {error ? (
        <p className="mt-1.5 text-xs text-mm-red-deep">{error}</p>
      ) : help ? (
        <p className="mt-1.5 text-xs text-mist-400">{help}</p>
      ) : null}
    </div>
  );
}

/** Segmented control — big tappable pills, one active = brand-red. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  columns,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  columns?: number;
}) {
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "focus-ring flex min-h-[56px] items-center justify-center rounded-md border px-2 text-center text-sm font-semibold transition-colors",
              active
                ? "border-mm-red bg-mm-red text-white"
                : "border-input bg-card text-foreground hover:bg-muted active:bg-muted",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Toggle card with a tick box on the left (add-on / congestion). */
function ToggleCard({
  active,
  title,
  sub,
  onToggle,
}: {
  active: boolean;
  title: string;
  sub: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "focus-ring flex w-full items-center gap-3 rounded-md border p-4 text-left transition-colors",
        active ? "border-mm-red bg-card ring-1 ring-inset ring-mm-red/30" : "border-input bg-card hover:bg-muted active:bg-muted",
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded border",
          active ? "border-mm-red bg-mm-red text-white" : "border-input bg-card",
        )}
      >
        {active ? <Plus className="size-4 rotate-45" strokeWidth={2.5} /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="block text-xs text-mist-400">{sub}</span>
      </span>
    </button>
  );
}

/** Plus/minus stepper. 44px touch targets. */
function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  suffix?: string;
}) {
  const clamp = (n: number) => Math.max(min, n);
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label="Decrease"
        onClick={() => onChange(clamp(value - step))}
        className="focus-ring flex size-11 items-center justify-center rounded-md border border-input bg-card text-foreground hover:bg-muted active:bg-muted"
      >
        <Minus className="size-5" strokeWidth={1.75} />
      </button>
      <span className="tabular w-14 text-center text-base font-semibold text-foreground">
        {value}
        {suffix ? <span className="ml-0.5 text-xs text-mist-400">{suffix}</span> : null}
      </span>
      <button
        type="button"
        aria-label="Increase"
        onClick={() => onChange(clamp(value + step))}
        className="focus-ring flex size-11 items-center justify-center rounded-md border border-input bg-card text-foreground hover:bg-muted active:bg-muted"
      >
        <Plus className="size-5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function CurrencyField({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  help?: string;
}) {
  return (
    <div className="mb-5">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex h-14 items-center rounded-md border border-input bg-card px-4 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30">
        <span className="mr-1 text-base text-mist-400">£</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={Number.isNaN(value) ? "" : value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="tabular h-full w-full bg-transparent text-base text-foreground focus:outline-none"
        />
      </div>
      {help ? <p className="mt-1.5 text-xs text-mist-400">{help}</p> : null}
    </div>
  );
}

function StepHeader({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-3">
      <div>
        <h2 className="font-display text-2xl text-foreground">{title}</h2>
        <p className="mt-0.5 text-sm text-mist-400">{sub}</p>
      </div>
      {right}
    </div>
  );
}

/* ---------- step type ---------- */

type Setter = <K extends keyof QuoteFormValues>(key: K, value: QuoteFormValues[K]) => void;

interface StepProps {
  values: QuoteFormValues;
  set: Setter;
  /** Present when the quote is tied to a lead — enables survey notes + photo capture. */
  leadId?: string | null;
  /** Active (settings-driven) prices; falls back to the constant defaults. */
  pricing?: PricingConfig;
}

/** Shared survey-note textarea (Marley field styling). */
function SurveyNotes({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <textarea
        id={id}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm text-foreground placeholder:text-mist-300 focus:border-mm-red focus:outline-none focus:ring-2 focus:ring-mm-red/20"
      />
    </div>
  );
}

/* ---------- STEP 1 — CUSTOMER ---------- */

export function Step1Customer({
  values,
  set,
  showErrors,
}: StepProps & { showErrors?: boolean }) {
  const c = values.customer;
  const [touched, setTouched] = useState<{ name?: boolean; email?: boolean }>({});
  const nameErr = !c.name.trim() ? "Enter the customer's name." : undefined;
  const emailErr = !c.email.trim()
    ? "Enter an email address."
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim())
      ? "Enter a valid email address."
      : undefined;
  return (
    <div>
      <StepHeader title="Customer" sub="Who is this quote for?" />
      <TextField
        label="Full name"
        required
        autoComplete="name"
        placeholder="e.g. Jane Smith"
        value={c.name}
        onChange={(e) => set("customer", { ...c, name: e.target.value })}
        onBlur={() => setTouched((t) => ({ ...t, name: true }))}
        error={(touched.name || showErrors) && nameErr ? nameErr : undefined}
      />
      <TextField
        label="Phone or mobile"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="e.g. 07700 900000"
        value={c.phone}
        onChange={(e) => set("customer", { ...c, phone: e.target.value })}
      />
      <TextField
        label="Email address"
        required
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="e.g. jane@example.com"
        value={c.email}
        onChange={(e) => set("customer", { ...c, email: e.target.value })}
        onBlur={() => setTouched((t) => ({ ...t, email: true }))}
        error={(touched.email || showErrors) && emailErr ? emailErr : undefined}
      />
    </div>
  );
}

/* ---------- STEP 2 — JOB DETAILS + mileage ---------- */

export function Step2Job({ values, set, pricing }: StepProps) {
  const j = values.job;
  const route = values.route;
  const extraDayRate = pricing?.extraDayRate ?? 0;
  const [calc, setCalc] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  // Back-compat: quotes saved before structured addresses only have the string —
  // seed the structured value's line1 from it so nothing is lost on open.
  const collectAddress: AddressValue = j.collectAddress ?? { ...BLANK_QUOTE_ADDRESS, line1: j.collectAddr || "" };
  const destAddress: AddressValue = j.destAddress ?? { ...BLANK_QUOTE_ADDRESS, line1: j.destAddr || "" };
  // Editing either address invalidates a previously-calculated route: the miles
  // (and the price that depends on them) no longer match the addresses. Clear it
  // so the step-2 gate forces a recalculate before the quote can proceed
  // (Peter, 2026-07-30).
  const clearStaleRoute = () => {
    if (route.deadMiles != null || route.jobMiles != null || route.routeLegs.length > 0) {
      set("route", { deadMiles: null, jobMiles: null, routeLegs: [] });
    }
  };
  const setCollect = (next: AddressValue) => {
    clearStaleRoute();
    set("job", { ...j, collectAddress: next, collectAddr: composeAddr(next) });
  };
  const setDest = (next: AddressValue) => {
    clearStaleRoute();
    set("job", { ...j, destAddress: next, destAddr: composeAddr(next) });
  };

  async function calculateMileage() {
    if (!j.collectAddr.trim() || !j.destAddr.trim()) {
      setCalc({ loading: false, error: "Enter both addresses first." });
      return;
    }
    setCalc({ loading: true, error: null });
    try {
      const res = await fetch("/api/maps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectAddr: j.collectAddr, destAddr: j.destAddr }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCalc({ loading: false, error: data.error || "Mileage lookup failed." });
        return;
      }
      const legs: RouteLeg[] = (data.legs ?? []).map((l: { label: string; dist: string }) => ({
        label: l.label,
        dist: l.dist,
        time: "",
      }));
      set("route", { deadMiles: data.deadMiles, jobMiles: data.jobMiles, routeLegs: legs });
      setCalc({ loading: false, error: null });
    } catch (err) {
      setCalc({ loading: false, error: err instanceof Error ? err.message : "Mileage lookup failed." });
    }
  }

  const totalMiles = route.deadMiles != null && route.jobMiles != null ? route.deadMiles + route.jobMiles : null;

  return (
    <div>
      <StepHeader title="Job Details" sub="Where are we going?" />
      <div className="mb-5 rounded-md border border-border bg-card p-4">
        <FieldLabel required>Collection address</FieldLabel>
        <AddressFields value={collectAddress} onChange={setCollect} idPrefix="q-collect" />
      </div>
      <div className="mb-5 rounded-md border border-border bg-card p-4">
        <FieldLabel required>Destination address</FieldLabel>
        <AddressFields value={destAddress} onChange={setDest} idPrefix="q-dest" />
      </div>

      <button
        type="button"
        onClick={calculateMileage}
        disabled={calc.loading}
        className={cn(
          "mb-4 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-md border border-input bg-card",
          "text-sm font-semibold text-foreground active:bg-muted disabled:opacity-60",
        )}
      >
        {calc.loading ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
        ) : (
          <MapPin className="size-4" strokeWidth={1.75} />
        )}
        Calculate route &amp; mileage
      </button>

      {calc.error ? (
        <p className="mb-4 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{calc.error}</p>
      ) : null}

      {route.routeLegs.length > 0 ? (
        <div className="mb-6 rounded-md border border-border bg-muted p-4">
          <p className="eyebrow mb-2">Route breakdown</p>
          <ul className="space-y-1.5">
            {route.routeLegs.map((leg, i) => (
              <li key={i} className="flex items-center justify-between text-sm text-foreground">
                <span className="text-mist-500">{leg.label}</span>
                <span className="tabular font-semibold">{leg.dist}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-sm">
            <span className="font-semibold text-foreground">Total miles (dead + job)</span>
            <span className="tabular font-semibold text-foreground">
              {totalMiles != null ? `${totalMiles} mi` : "—"}
            </span>
          </div>
        </div>
      ) : null}

      <div className="mb-5">
        <FieldLabel>Moving date</FieldLabel>
        <input
          type="date"
          value={j.moveDate}
          onChange={(e) => set("job", { ...j, moveDate: e.target.value })}
          className="h-14 w-full rounded-md border border-input bg-card px-4 text-base text-foreground focus:border-mm-red focus:outline-none focus:ring-2 focus:ring-mm-red/30"
        />
        <label className="mt-3 flex items-center gap-2.5 text-sm text-mist-500">
          <input
            type="checkbox"
            checked={j.moveDateEstimated}
            onChange={(e) => set("job", { ...j, moveDateEstimated: e.target.checked })}
            className="size-5 accent-[#c03838]"
          />
          This date is an estimate (customer has not confirmed)
        </label>
      </div>

      <div className="mb-5">
        <FieldLabel>Days on the job</FieldLabel>
        {/* Stepper, not a bare number input — iPads don't render native
            spinners, so the field read as type-only with no +/- controls. */}
        <Stepper value={Number(j.days) || 1} min={1} onChange={(v) => set("job", { ...j, days: v })} />
        <p className="mt-1.5 text-xs text-mist-400">
          {extraDayRate > 0
            ? `Each day after the first adds ${gbp(extraDayRate)} to the quote.`
            : "Also feeds internal costing (labour + vans). Set an extra-day price in Settings to charge for additional days."}
        </p>
      </div>

      <div className="mb-5">
        <FieldLabel>Property scope</FieldLabel>
        <Segmented
          value={j.scope}
          onChange={(v) => set("job", { ...j, scope: v })}
          options={[
            { value: "rented", label: "Rented" },
            { value: "owned", label: "Owned" },
          ]}
        />
      </div>

      <div className="mb-5">
        <FieldLabel>Beds left overnight?</FieldLabel>
        <Segmented
          value={j.bedsOvernight}
          onChange={(v) => set("job", { ...j, bedsOvernight: v })}
          options={[
            { value: "no", label: "No" },
            { value: "yes", label: "Yes" },
          ]}
        />
      </div>
    </div>
  );
}

/* ---------- STEP 3 — VEHICLE & PACKING ---------- */

export interface CubicQuoteHint {
  rawFt3: number;
  planningFt3: number;
  contingencyPct: number;
  vehicleKey: VehicleKey;
  /** "2 Lutons" / "Transit van" */
  shortLabel: string;
  /** Full sentence for the chip's small print. */
  detail: string;
}

export function Step3Vehicle({
  values,
  set,
  leadId,
  pricing,
  cubicHint,
}: StepProps & { cubicHint?: CubicQuoteHint | null }) {
  const base = pricing?.base ?? BASE_PRICES;
  const pack = pricing?.pack ?? PACK_PRICES;
  const addon75Base = pricing?.addon75Base ?? ADDON_75T_BASE;
  const addonTransitBase = pricing?.addonTransitBase ?? ADDON_TRANSIT_BASE;
  const packPrices = pack[values.vehicle];
  const packLabel = (k: PackingKey) => (packPrices[k] === 0 ? "Included" : `+${gbp(packPrices[k])}`);
  const vehicleLabel = (k: VehicleKey) =>
    k === "transit"
      ? `Transit van (1 man) — ${gbp(base[k])}`
      : `${VAN_COUNT[k]} Luton ${VAN_COUNT[k] === 1 ? "van" : "vans"} — ${gbp(base[k])}`;
  return (
    <div>
      <StepHeader title="Vehicle &amp; Packing" sub="What is the move size?" />

      {/* Cubic-survey recommendation — suggest-only on an existing quote;
          new drafts are already pre-selected at creation. */}
      {cubicHint ? (
        <div className="mb-4 flex flex-wrap items-center gap-2.5 rounded-md border border-mm-red/25 bg-mm-red-tint/40 px-3.5 py-2.5">
          <span className="text-sm text-foreground">
            Cubic survey: <strong className="tabular">{cubicHint.rawFt3.toLocaleString("en-GB")} ft³ raw</strong>{cubicHint.contingencyPct > 0 ? <> + {cubicHint.contingencyPct}% = <strong>{cubicHint.planningFt3.toLocaleString("en-GB")} ft³ planning</strong></> : null} →{" "}
            <strong>{cubicHint.shortLabel}</strong>
            <span className="ml-1.5 text-xs text-mist-500">{cubicHint.detail}</span>
          </span>
          <span className="ml-auto flex items-center gap-2">
            {values.vehicle !== cubicHint.vehicleKey ? (
              <button
                type="button"
                onClick={() => set("vehicle", cubicHint.vehicleKey)}
                className="focus-ring inline-flex min-h-9 items-center rounded-md bg-mm-red px-3 text-xs font-semibold text-white hover:bg-mm-red-deep"
              >
                Use {cubicHint.shortLabel}
              </button>
            ) : (
              <span className="text-xs font-semibold text-success">Matches selection</span>
            )}
            {leadId ? (
              <Link
                href={`/leads/${leadId}/cubic`}
                className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-card px-3 text-xs font-medium text-foreground hover:bg-muted"
              >
                <Boxes className="size-3.5" strokeWidth={1.75} />
                Open survey
              </Link>
            ) : null}
          </span>
        </div>
      ) : leadId ? (
        /* No survey yet — offer to do one right from the quote form. */
        <Link
          href={`/leads/${leadId}/cubic`}
          className="focus-ring mb-4 flex items-center gap-2.5 rounded-md border border-dashed border-mm-red/40 bg-mm-red-tint/20 px-3.5 py-2.5 text-sm text-foreground hover:bg-mm-red-tint/40"
        >
          <Boxes className="size-4 text-mm-red" strokeWidth={1.75} />
          <span>
            <strong>Do a cubic survey</strong> to size the vans from the actual volume — opens the tablet survey.
          </span>
        </Link>
      ) : null}

      <div className="mb-5">
        <FieldLabel>Vehicle</FieldLabel>
        <Select value={values.vehicle} onValueChange={(v) => set("vehicle", v as VehicleKey)}>
          <SelectTrigger className="h-14 text-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VEHICLE_KEYS.map((k) => (
              <SelectItem key={k} value={k}>
                {vehicleLabel(k)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mb-5">
        <FieldLabel>7.5 tonne lorries</FieldLabel>
        <Select value={String(values.sevenFiveT ?? 0)} onValueChange={(v) => set("sevenFiveT", Number(v))}>
          <SelectTrigger className="h-14 text-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">None</SelectItem>
            <SelectItem value="1">1 lorry — +{gbp(addon75Base)}</SelectItem>
            <SelectItem value="2">2 lorries — +{gbp(addon75Base * 2)}</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-xs text-mist-400">Each adds the 7.5t base (plus packing add-on if applicable).</p>
      </div>

      <div className="mb-5">
        <FieldLabel>Transit vans (add-on)</FieldLabel>
        <Select value={String(values.transitVans ?? 0)} onValueChange={(v) => set("transitVans", Number(v))}>
          <SelectTrigger className="h-14 text-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">None</SelectItem>
            <SelectItem value="1">1 van — +{gbp(addonTransitBase)}</SelectItem>
            <SelectItem value="2">2 vans — +{gbp(addonTransitBase * 2)}</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-xs text-mist-400">Each adds a Transit with its 1 man included.</p>
      </div>

      <div className="mb-5">
        <FieldLabel>Packing service</FieldLabel>
        <div className="space-y-2">
          {(
            [
              { key: "owner", title: "Owner pack", sub: "Customer packs everything" },
              { key: "fragile", title: "Fragile only", sub: "We pack the fragile items" },
              { key: "full", title: "Full pack", sub: "We pack everything" },
            ] as { key: PackingKey; title: string; sub: string }[]
          ).map((p) => {
            const active = values.packing === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => set("packing", p.key)}
                className={cn(
                  "focus-ring flex w-full items-center justify-between rounded-md border p-4 text-left transition-colors",
                  active ? "border-mm-red bg-card ring-1 ring-inset ring-mm-red/30" : "border-input bg-card hover:bg-muted active:bg-muted",
                )}
              >
                <span>
                  <span className="block text-sm font-semibold text-foreground">{p.title}</span>
                  <span className="block text-xs text-mist-400">{p.sub}</span>
                </span>
                <span className={cn("tabular text-sm font-semibold", active ? "text-mm-red-deep" : "text-foreground")}>
                  {packLabel(p.key)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------- STEP 4 — ACCESS & PROPERTY ---------- */

function AccessSide({
  title,
  data,
  onChange,
}: {
  title: string;
  data: QuoteFormValues["collect"];
  onChange: (next: QuoteFormValues["collect"]) => void;
}) {
  const isFlat = data.type === "flat";
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <p className="eyebrow mb-3">{title}</p>

      <div className="mb-5">
        <FieldLabel>Property type</FieldLabel>
        <Segmented<PropertyType>
          value={data.type}
          onChange={(v) => onChange({ ...data, type: v })}
          options={[
            { value: "house", label: "House" },
            { value: "flat", label: "Flat" },
          ]}
        />
      </div>

      {isFlat ? (
        <>
          <div className="mb-5">
            <FieldLabel>Lift available?</FieldLabel>
            <Segmented
              value={data.lift}
              onChange={(v) => onChange({ ...data, lift: v })}
              options={[
                { value: "no", label: "No lift" },
                { value: "yes", label: "Has lift" },
              ]}
            />
          </div>
          <div className="mb-5">
            <FieldLabel>Floor level</FieldLabel>
            <Segmented<FloorKey>
              value={data.floor}
              columns={4}
              onChange={(v) => onChange({ ...data, floor: v })}
              options={[
                { value: "ground", label: "G" },
                { value: "1st", label: "1st" },
                { value: "2nd", label: "2nd" },
                { value: "3rd", label: "3rd+" },
              ]}
            />
          </div>
        </>
      ) : null}

      <div>
        <FieldLabel>Access distance (metres)</FieldLabel>
        <Stepper
          value={data.accessM}
          step={5}
          onChange={(v) => onChange({ ...data, accessM: v })}
          suffix="m"
        />
        <p className="mt-1.5 text-xs text-mist-400">Distance from van to front door</p>
      </div>
    </div>
  );
}

export function Step4Access({ values, set, leadId }: StepProps) {
  return (
    <div>
      <StepHeader title="Access &amp; Property" sub="Collection and destination details." />
      <div className="grid gap-4 md:grid-cols-2">
        <AccessSide title="Collection" data={values.collect} onChange={(next) => set("collect", next)} />
        <AccessSide title="Destination" data={values.dest} onChange={(next) => set("dest", next)} />
      </div>

      {/* Survey — access capture from the visit (notes saved with the quote; photos to the lead) */}
      <div className="mt-6 space-y-4 rounded-md border border-border bg-muted/30 p-4">
        <p className="eyebrow">Survey · access</p>
        <SurveyNotes
          id="survey-access-notes"
          label="Access notes"
          placeholder="Parking, stairs, lift, narrow doorways, long carries…"
          value={values.survey.accessNotes}
          onChange={(v) => set("survey", { ...values.survey, accessNotes: v })}
        />
        {leadId ? (
          <SurveyPhotos leadId={leadId} category="access" label="Access" />
        ) : (
          <p className="text-xs text-mist-400">Link this quote to a lead to attach access photos.</p>
        )}
      </div>
    </div>
  );
}

/* ---------- STEP 5 — ADDITIONAL CHARGES ---------- */

export function Step5Extras({ values, set }: StepProps) {
  const e = values.extras;
  // vanCount for the congestion preview: base vehicle + 7.5t lorries + add-on Transits.
  const vanCount = VAN_COUNT[values.vehicle] + (values.sevenFiveT ?? 0) + (values.transitVans ?? 0);
  const congestionPreview = e.congestion ? vanCount * 20 : 0;
  return (
    <div>
      <StepHeader title="Additional Charges" sub="Any special conditions?" />
      <div className="mb-5">
        <ToggleCard
          active={e.congestion}
          title="Congestion charge"
          sub={`£20 per van — currently ${gbp(congestionPreview)} (${vanCount} ${vanCount === 1 ? "van" : "vans"})`}
          onToggle={() => set("extras", { ...e, congestion: !e.congestion })}
        />
      </div>
      <CurrencyField label="Toll charges" value={e.tolls} onChange={(v) => set("extras", { ...e, tolls: v })} />
      <CurrencyField label="Parking permit" value={e.parking} onChange={(v) => set("extras", { ...e, parking: v })} />
    </div>
  );
}

/* ---------- STEP 6 — ITEMS & MATERIALS ---------- */

export function Step6Items({ values, set, leadId }: StepProps) {
  const items = values.items;
  const setItem = (key: keyof QuoteItems, v: number) => set("items", { ...items, [key]: v });
  const groups: ItemGroup[] = ["Boxes", "Covers", "Piano"];
  const groupTitle: Record<ItemGroup, string> = {
    Boxes: "Boxes",
    Covers: "Protective covers",
    Piano: "Piano",
  };
  return (
    <div>
      <StepHeader title="Items &amp; Materials" sub="Tap + to add items." />
      <p className="mb-5 rounded-md bg-muted px-3 py-2 text-xs text-mist-500">
        Inventory only — not charged on the quote.
      </p>
      {groups.map((group) => (
        <div key={group} className="mb-6">
          <p className="eyebrow mb-3">{groupTitle[group]}</p>
          <div className="divide-y divide-border rounded-md border border-border bg-card">
            {ITEM_FIELDS.filter((f) => f.group === group).map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm text-foreground">{f.label}</span>
                <Stepper value={items[f.key]} step={f.step ?? 1} onChange={(v) => setItem(f.key, v)} />
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Survey — large items / extra packing capture from the visit */}
      <div className="space-y-4 rounded-md border border-border bg-muted/30 p-4">
        <p className="eyebrow">Survey · large items &amp; extra packing</p>
        <SurveyNotes
          id="survey-large-notes"
          label="Large items / extra packing notes"
          placeholder="Pianos, safes, fragile or oversized items, dismantling needs…"
          value={values.survey.largeItemsNotes}
          onChange={(v) => set("survey", { ...values.survey, largeItemsNotes: v })}
        />
        {leadId ? (
          <SurveyPhotos leadId={leadId} category="large_items" label="Large items" />
        ) : (
          <p className="text-xs text-mist-400">Link this quote to a lead to attach large-item photos.</p>
        )}
      </div>
    </div>
  );
}

/* ---------- STEP 7 — REVIEW & SEND ---------- */

const DISCOUNT_PCTS = [5, 10, 15, 20, 25] as const;

export function Step7Review({
  values,
  set,
  breakdown,
  actions,
  settings,
}: StepProps & {
  breakdown: QuoteBreakdown;
  actions: React.ReactNode;
  /** Cost rates for the internal margin figure. Absent → no margin shown. */
  settings?: BusinessSettings | null;
}) {
  const r = values.review;
  const b = breakdown;
  const [expiry] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 30);
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  });

  // Internal margin on the ex-VAT total vs the job's cost from the Settings rate card.
  const margin = settings
    ? marginPct(
        b.total,
        jobCost(
          {
            vehicle: values.vehicle,
            sevenFiveT: values.sevenFiveT ?? 0,
            transitVans: values.transitVans ?? 0,
            totalMiles: b.totalMiles ?? 0,
            boxes: boxesFromItems(values.items as unknown as Record<string, number>),
            days: Number(values.job.days) || 1,
          },
          settings,
        ).total,
      )
    : null;

  const pctAmount = (pct: number) => Math.round(b.subtotal * pct) / 100; // pct of subtotal, 2dp
  const activePct = DISCOUNT_PCTS.find((pct) => Math.abs(r.discount - pctAmount(pct)) < 0.005) ?? null;

  return (
    <div>
      <StepHeader
        title="Review &amp; Send"
        sub="Confirm the figures, then send the quote."
        right={
          margin != null ? (
            <span
              className={cn(
                "tabular font-display text-xl font-semibold",
                margin < 0 ? "text-mm-red" : "text-mist-500",
              )}
              title="Margin"
            >
              {margin}%
            </span>
          ) : null
        }
      />

      <div className="mb-3">
        <FieldLabel>Discount %</FieldLabel>
        <div className="grid grid-cols-5 gap-2">
          {DISCOUNT_PCTS.map((pct) => {
            const active = activePct === pct;
            return (
              <button
                key={pct}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  set("review", { ...r, discount: active ? 0 : pctAmount(pct) })
                }
                className={cn(
                  "focus-ring flex min-h-11 items-center justify-center rounded-md border text-sm font-semibold transition-colors",
                  active
                    ? "border-mm-red bg-mm-red text-white"
                    : "border-input bg-card text-foreground hover:bg-muted active:bg-muted",
                )}
              >
                {pct}%
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs text-mist-400">Fills the discount below as a percentage of the subtotal. Tap again to clear.</p>
      </div>

      <CurrencyField
        label="Discount"
        value={r.discount}
        onChange={(v) => set("review", { ...r, discount: v })}
        help="Subtracted from the total. Goodwill or returning-customer adjustments live here."
      />

      {/* Additional charges — internal uplift (PRD §3.9). Priced into the total
          but folded inside the customer's "Your Removal" line: the customer sees
          the number in their total, never as its own line, and the reason never
          leaves the office. Grouped with the Discount box above by design. */}
      <div className="mb-5 rounded-md border border-border bg-muted/40 p-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <FieldLabel>Additional charges</FieldLabel>
          <span className="text-xs font-medium text-mist-400">Internal — not shown to the customer.</span>
        </div>
        <CurrencyField
          label="Amount"
          value={r.additionalCharges}
          onChange={(v) => set("review", { ...r, additionalCharges: v })}
          help="Added to the quote total inside “Your Removal” — the customer never sees it itemised."
        />
        <FieldLabel>Reason</FieldLabel>
        <input
          type="text"
          value={r.additionalChargesReason}
          onChange={(e) => set("review", { ...r, additionalChargesReason: e.target.value })}
          placeholder="e.g. commercial access, stairs, specialist handling"
          className="h-12 w-full rounded-md border border-input bg-card px-4 text-base text-foreground placeholder:text-mist-300 focus:border-mm-red focus:outline-none focus:ring-2 focus:ring-mm-red/30"
        />
        <p className="mt-1.5 text-xs text-mist-400">Saved with the quote and shown to office and estimator only.</p>
      </div>

      {/* Total card */}
      <div className="mb-6 overflow-hidden rounded-md border border-border">
        <div className="border-l-4 border-mm-red p-5">
          <p className="eyebrow">Quote total</p>
          <p className="font-display tabular mt-1 text-4xl font-bold text-foreground">{gbp(b.grandTotal)}</p>
          <div className="mt-2 space-y-0.5 text-xs text-mist-400">
            {b.discount > 0 ? (
              <p className="tabular">
                After {gbp(b.discount)} discount · subtotal {gbp(b.subtotal)}
              </p>
            ) : (
              <p className="tabular">Subtotal {gbp(b.subtotal)} (includes £150 admin fee)</p>
            )}
            {b.vatEnabled ? (
              <p className="tabular">
                {gbp(b.total)} + {gbp(b.vatAmount)} VAT
              </p>
            ) : (
              <p>No VAT</p>
            )}
            <p>Valid 30 days · expires {expiry}</p>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <FieldLabel>Notes (optional, internal)</FieldLabel>
        <textarea
          rows={4}
          value={r.quoteNotes}
          onChange={(e) => set("review", { ...r, quoteNotes: e.target.value })}
          placeholder="Anything Luke / Connor should know — site survey notes, customer asks, follow-up reminders…"
          className="w-full rounded-md border border-input bg-card p-4 text-base text-foreground placeholder:text-mist-300 focus:border-mm-red focus:outline-none focus:ring-2 focus:ring-mm-red/30"
        />
        <p className="mt-1.5 text-xs text-mist-400">
          Saved with the quote. Does not appear on the customer PDF or email.
        </p>
      </div>

      {actions}
    </div>
  );
}
