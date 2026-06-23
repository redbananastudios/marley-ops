import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Business settings — editable rates + costs (singleton row). The estimator fee is
 * live (feeds Performance + the dashboard). The cost rates are captured here ready
 * to drive margin-per-job once the cost formula is agreed.
 */
export interface BusinessSettings {
  estimatorFee: number;
  costFuelPerMile: number;
  costLabourPerHour: number;
  costBox: number;
  costVanDay: number;
  costMisc: number;
}

export const DEFAULT_SETTINGS: BusinessSettings = {
  estimatorFee: 50,
  costFuelPerMile: 0,
  costLabourPerHour: 0,
  costBox: 0,
  costVanDay: 0,
  costMisc: 0,
};

/** Read the singleton settings row, falling back to defaults if absent. */
export async function getBusinessSettings(
  sb: SupabaseClient,
): Promise<BusinessSettings> {
  const { data } = await sb
    .from("business_settings")
    .select("estimator_fee, cost_fuel_per_mile, cost_labour_per_hour, cost_box, cost_van_day, cost_misc")
    .eq("id", true)
    .maybeSingle();
  if (!data) return { ...DEFAULT_SETTINGS };
  return {
    estimatorFee: Number(data.estimator_fee ?? DEFAULT_SETTINGS.estimatorFee),
    costFuelPerMile: Number(data.cost_fuel_per_mile ?? 0),
    costLabourPerHour: Number(data.cost_labour_per_hour ?? 0),
    costBox: Number(data.cost_box ?? 0),
    costVanDay: Number(data.cost_van_day ?? 0),
    costMisc: Number(data.cost_misc ?? 0),
  };
}
