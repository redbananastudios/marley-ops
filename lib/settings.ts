import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Business settings — editable rates + costs (singleton row). The estimator fee is
 * live (feeds Performance + the dashboard). The cost rates are captured here ready
 * to drive margin-per-job once the cost formula is agreed.
 */
export interface BusinessSettings {
  estimatorFee: number;
  costFuelPerMile: number;
  costLabourPerDay: number;
  costBox: number;
  costVanDay: number;
  cost75t: number;
  costMisc: number;
  /** New quotes default to VAT enabled when true. */
  vatDefault: boolean;
  /** Yard/base location — mileage origin + the clients map "route from base". */
  baseLocation: string;
}

/** The Marley yard the live quote tool hardcoded — default base until changed in Settings. */
export const DEFAULT_BASE_LOCATION = "Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX";

export const DEFAULT_SETTINGS: BusinessSettings = {
  estimatorFee: 50,
  costFuelPerMile: 0,
  costLabourPerDay: 120,
  costBox: 0,
  costVanDay: 0,
  cost75t: 1800,
  costMisc: 0,
  vatDefault: true,
  baseLocation: DEFAULT_BASE_LOCATION,
};

/** Read the singleton settings row, falling back to defaults if absent. */
export async function getBusinessSettings(
  sb: SupabaseClient,
): Promise<BusinessSettings> {
  const { data } = await sb
    .from("business_settings")
    .select("estimator_fee, cost_fuel_per_mile, cost_labour_per_day, cost_box, cost_van_day, cost_75t, cost_misc, vat_default, base_location")
    .eq("id", true)
    .maybeSingle();
  if (!data) return { ...DEFAULT_SETTINGS };
  return {
    estimatorFee: Number(data.estimator_fee ?? DEFAULT_SETTINGS.estimatorFee),
    costFuelPerMile: Number(data.cost_fuel_per_mile ?? 0),
    costLabourPerDay: Number(data.cost_labour_per_day ?? DEFAULT_SETTINGS.costLabourPerDay),
    costBox: Number(data.cost_box ?? 0),
    costVanDay: Number(data.cost_van_day ?? 0),
    cost75t: Number(data.cost_75t ?? DEFAULT_SETTINGS.cost75t),
    costMisc: Number(data.cost_misc ?? 0),
    vatDefault: data.vat_default ?? DEFAULT_SETTINGS.vatDefault,
    baseLocation: (data.base_location as string | null)?.trim() || DEFAULT_BASE_LOCATION,
  };
}
