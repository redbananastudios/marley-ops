import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PRICING, type PricingConfig } from "./pricing";
import { VEHICLE_KEYS, type VehicleKey } from "./constants";

/**
 * The editable slice of the pricing config — the van + 7.5t prices Connor can tune from
 * Settings. Floor charges, admin fee, mileage rate and congestion stay code-side for now.
 * Stored in business_settings.pricing (jsonb); NULL → code defaults.
 */
export interface EditablePricing {
  base: Record<VehicleKey, number>;
  pack: Record<VehicleKey, { full: number; fragile: number }>;
  addon75Base: number;
  addon75Pack: { full: number; fragile: number };
  /** Add-on Transit van: flat per van, 1 man included. */
  addonTransitBase: number;
  /** Charge per day AFTER the first on multi-day jobs. */
  extraDayRate: number;
}

/** Pull the editable defaults out of the code DEFAULT_PRICING (the seed shown in Settings). */
export function defaultEditablePricing(): EditablePricing {
  const base = {} as Record<VehicleKey, number>;
  const pack = {} as Record<VehicleKey, { full: number; fragile: number }>;
  for (const k of VEHICLE_KEYS) {
    base[k] = DEFAULT_PRICING.base[k];
    pack[k] = { full: DEFAULT_PRICING.pack[k].full, fragile: DEFAULT_PRICING.pack[k].fragile };
  }
  return {
    base,
    pack,
    addon75Base: DEFAULT_PRICING.addon75Base,
    addon75Pack: { full: DEFAULT_PRICING.addon75Pack.full, fragile: DEFAULT_PRICING.addon75Pack.fragile },
    addonTransitBase: DEFAULT_PRICING.addonTransitBase,
    extraDayRate: DEFAULT_PRICING.extraDayRate,
  };
}

/** Merge an editable slice over DEFAULT_PRICING into the full config computeQuote() needs. */
export function toPricingConfig(e: EditablePricing): PricingConfig {
  const base = {} as Record<VehicleKey, number>;
  const pack = {} as PricingConfig["pack"];
  for (const k of VEHICLE_KEYS) {
    base[k] = Number(e.base?.[k] ?? DEFAULT_PRICING.base[k]);
    pack[k] = {
      full: Number(e.pack?.[k]?.full ?? DEFAULT_PRICING.pack[k].full),
      fragile: Number(e.pack?.[k]?.fragile ?? DEFAULT_PRICING.pack[k].fragile),
      owner: 0,
    };
  }
  return {
    ...DEFAULT_PRICING,
    base,
    pack,
    addon75Base: Number(e.addon75Base ?? DEFAULT_PRICING.addon75Base),
    addon75Pack: {
      full: Number(e.addon75Pack?.full ?? DEFAULT_PRICING.addon75Pack.full),
      fragile: Number(e.addon75Pack?.fragile ?? DEFAULT_PRICING.addon75Pack.fragile),
      owner: 0,
    },
    addonTransitBase: Number(e.addonTransitBase ?? DEFAULT_PRICING.addonTransitBase),
    extraDayRate: Number(e.extraDayRate ?? DEFAULT_PRICING.extraDayRate),
  };
}

/** Read the active pricing config — settings.pricing merged over the defaults. */
export async function getPricingConfig(sb: SupabaseClient): Promise<PricingConfig> {
  const { data } = await sb.from("business_settings").select("pricing").eq("id", true).maybeSingle();
  const stored = data?.pricing as EditablePricing | null | undefined;
  if (!stored) return DEFAULT_PRICING;
  return toPricingConfig(stored);
}

/** Read the editable slice for the Settings form (current saved values, or the defaults). */
export async function getEditablePricing(sb: SupabaseClient): Promise<EditablePricing> {
  const { data } = await sb.from("business_settings").select("pricing").eq("id", true).maybeSingle();
  const stored = data?.pricing as EditablePricing | null | undefined;
  if (!stored) return defaultEditablePricing();
  // Merge over defaults so a newly-added tier (e.g. 5luton) still shows.
  const d = defaultEditablePricing();
  const base = { ...d.base, ...(stored.base ?? {}) };
  const pack = { ...d.pack } as EditablePricing["pack"];
  for (const k of VEHICLE_KEYS) {
    pack[k] = { ...d.pack[k], ...(stored.pack?.[k] ?? {}) };
  }
  return {
    base,
    pack,
    addon75Base: stored.addon75Base ?? d.addon75Base,
    addon75Pack: { ...d.addon75Pack, ...(stored.addon75Pack ?? {}) },
    addonTransitBase: stored.addonTransitBase ?? d.addonTransitBase,
    extraDayRate: stored.extraDayRate ?? d.extraDayRate,
  };
}
