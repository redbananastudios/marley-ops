import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Business settings — editable rates + costs (singleton row). The estimator fee is
 * live (feeds Performance + the dashboard). The cost rates are captured here ready
 * to drive margin-per-job once the cost formula is agreed.
 */
export interface BusinessSettings {
  estimatorFee: number;
  /** Luton van fuel cost per mile (billed per Luton). */
  costFuelPerMile: number;
  /** 7.5t lorry fuel cost per mile (billed per lorry). */
  costFuel75PerMile: number;
  costLabourPerDay: number;
  costBox: number;
  costVanDay: number;
  /** Transit van day rate (vehicle only — its man is billed via labour). */
  costTransitDay: number;
  cost75t: number;
  costMisc: number;
  /** New quotes default to VAT enabled when true. */
  vatDefault: boolean;
  /** VAT registration number — printed on the quote PDF footer (legal requirement). */
  vatNumber: string;
  /** Yard/base location — mileage origin + the clients map "route from base". */
  baseLocation: string;
  /** Standard deposit £ — prefills "Request deposit" on a job (editable per job). */
  defaultDeposit: number;
  /** Google "write a review" link — the post-move review email sends only when set. */
  googleReviewUrl: string;
}

/** The Marley yard the live quote tool hardcoded — default base until changed in Settings. */
export const DEFAULT_BASE_LOCATION = "Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX";

export const DEFAULT_SETTINGS: BusinessSettings = {
  estimatorFee: 50,
  costFuelPerMile: 0.5,
  costFuel75PerMile: 0.5,
  costLabourPerDay: 120,
  costBox: 0,
  costVanDay: 0,
  costTransitDay: 0,
  cost75t: 1800,
  costMisc: 0,
  vatDefault: true,
  vatNumber: "",
  baseLocation: DEFAULT_BASE_LOCATION,
  defaultDeposit: 100, // £100 booking deposit (Peter, 2026-07-08)
  // Same place id the marleymoves.co.uk site links to.
  googleReviewUrl: "https://search.google.com/local/writereview?placeid=ChIJq8R84fCs_EkRc_9iHhFQXW8",
};

/** Read the singleton settings row, falling back to defaults if absent. */
export async function getBusinessSettings(
  sb: SupabaseClient,
): Promise<BusinessSettings> {
  const { data } = await sb
    .from("business_settings")
    .select("estimator_fee, cost_fuel_per_mile, cost_fuel_75_per_mile, cost_labour_per_day, cost_box, cost_van_day, cost_transit_day, cost_75t, cost_misc, vat_default, vat_number, base_location, default_deposit, google_review_url")
    .eq("id", true)
    .maybeSingle();
  if (!data) return { ...DEFAULT_SETTINGS };
  return {
    estimatorFee: Number(data.estimator_fee ?? DEFAULT_SETTINGS.estimatorFee),
    costFuelPerMile: Number(data.cost_fuel_per_mile ?? DEFAULT_SETTINGS.costFuelPerMile),
    costFuel75PerMile: Number(data.cost_fuel_75_per_mile ?? DEFAULT_SETTINGS.costFuel75PerMile),
    costLabourPerDay: Number(data.cost_labour_per_day ?? DEFAULT_SETTINGS.costLabourPerDay),
    costBox: Number(data.cost_box ?? 0),
    costVanDay: Number(data.cost_van_day ?? 0),
    costTransitDay: Number(data.cost_transit_day ?? 0),
    cost75t: Number(data.cost_75t ?? DEFAULT_SETTINGS.cost75t),
    costMisc: Number(data.cost_misc ?? 0),
    vatDefault: data.vat_default ?? DEFAULT_SETTINGS.vatDefault,
    vatNumber: (data.vat_number as string | null)?.trim() || "",
    baseLocation: (data.base_location as string | null)?.trim() || DEFAULT_BASE_LOCATION,
    defaultDeposit: Number(data.default_deposit ?? DEFAULT_SETTINGS.defaultDeposit) || DEFAULT_SETTINGS.defaultDeposit,
    googleReviewUrl: (data.google_review_url as string | null)?.trim() ?? DEFAULT_SETTINGS.googleReviewUrl,
  };
}
