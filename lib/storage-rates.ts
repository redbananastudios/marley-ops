import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Storage rate card — the standing policy's billing config
 * (docs/storage-billing-v2-prd.md §1). CUSTOMER figures only, VAT-INCLUSIVE,
 * from business_settings.storage_rates. This module is imported by client
 * components (letDefaultsForUnitType, gbpInc), so the admin-only supplier
 * cost side deliberately lives elsewhere — lib/storage-supplier.ts, which
 * must never be value-imported client-side. Lets FREEZE their rate/min at
 * creation, so editing the card never disturbs a running let.
 */

export interface StorageRates {
  /** Container, per calendar month, VAT-inclusive. */
  containerMonthInc: number;
  /** Crate, per week, VAT-inclusive (display; billing uses the day rate). */
  crateWeekInc: number;
  /** Crate day rate, VAT-inclusive (week ÷ 7). */
  crateDayInc: number;
  /** Crate minimum stay in days, invoiced upfront. */
  crateMinDays: number;
  /** Crate minimum-stay charge, VAT-inclusive. */
  crateMinInc: number;
  /** Handling, per crate per event (in/out/access), VAT-inclusive. */
  handlingEventInc: number;
}

export const DEFAULT_STORAGE_RATES: StorageRates = {
  containerMonthInc: 348,
  crateWeekInc: 21,
  crateDayInc: 3,
  crateMinDays: 28,
  crateMinInc: 84,
  handlingEventInc: 60, // £50 ex — pass-through of Sandys' charge, no markup (Peter, 22 Jul; PRD D1)
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function mapStorageRates(raw: unknown): StorageRates {
  const d = DEFAULT_STORAGE_RATES;
  if (!raw || typeof raw !== "object") return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    containerMonthInc: num(o.container_month_inc, d.containerMonthInc),
    crateWeekInc: num(o.crate_week_inc, d.crateWeekInc),
    crateDayInc: num(o.crate_day_inc, d.crateDayInc),
    crateMinDays: Math.max(1, Math.trunc(num(o.crate_min_days, d.crateMinDays)) || d.crateMinDays),
    crateMinInc: num(o.crate_min_inc, d.crateMinInc),
    handlingEventInc: num(o.handling_event_inc, d.handlingEventInc),
  };
}

/** DB (snake_case jsonb) shape from the typed card — the write half. */
export function storageRatesToDb(r: StorageRates): Record<string, unknown> {
  return {
    container_month_inc: r.containerMonthInc,
    crate_week_inc: r.crateWeekInc,
    crate_day_inc: r.crateDayInc,
    crate_min_days: r.crateMinDays,
    crate_min_inc: r.crateMinInc,
    handling_event_inc: r.handlingEventInc,
  };
}

export async function getStorageRates(sb: SupabaseClient): Promise<StorageRates> {
  const { data } = await sb.from("business_settings").select("storage_rates").eq("id", true).maybeSingle();
  return mapStorageRates((data as { storage_rates?: unknown } | null)?.storage_rates);
}

export const gbpInc = (n: number): string =>
  Number.isInteger(n) ? `£${n}` : `£${n.toFixed(2)}`;

/** Product defaults for a new let, by unit type (crates bill daily-arrears;
 *  everything else keeps the in-advance period model). */
export function letDefaultsForUnitType(
  unitType: string,
  rates: StorageRates,
):
  | { billingModel: "crate_daily"; rate: number; ratePeriod: "day"; minDays: number; minAmount: number }
  | { billingModel: "period"; rate: number | null; ratePeriod: "week" | "month"; minDays: null; minAmount: null } {
  if (unitType === "crate_250") {
    return {
      billingModel: "crate_daily",
      rate: rates.crateDayInc,
      ratePeriod: "day",
      minDays: rates.crateMinDays,
      minAmount: rates.crateMinInc,
    };
  }
  const isContainer = unitType === "container_20ft" || unitType === "container_40ft";
  return {
    billingModel: "period",
    rate: isContainer ? rates.containerMonthInc : null,
    ratePeriod: "month",
    minDays: null,
    minAmount: null,
  };
}
