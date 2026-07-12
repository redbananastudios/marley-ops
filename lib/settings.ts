import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_AI_MODEL, isApprovedAiModelId, type AiModelId } from "@/lib/ai/budget";

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
  /** Cubic-survey van planning: crews pack to ~this % of a van's usable volume. */
  cubicFillPct: number;
  /** Usable load volumes (ft³) per vehicle class — feeds the van recommendation. */
  cubicTransitFt3: number;
  cubicLutonFt3: number;
  cubic75tFt3: number;
  aiSurveyEnabled: boolean;
  aiGroundedReplayEnabled: boolean;
  aiModelDefault: AiModelId;
  aiModelEscalation: AiModelId;
  aiSurveyCapGbp: number;
  aiMonthlyCapGbp: number;
  aiMonthlyAlertGbp: number;
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
  cubicFillPct: 90,
  cubicTransitFt3: 280,
  cubicLutonFt3: 550,
  cubic75tFt3: 1400,
  aiSurveyEnabled: false,
  aiGroundedReplayEnabled: false,
  aiModelDefault: DEFAULT_AI_MODEL,
  aiModelEscalation: DEFAULT_AI_MODEL,
  aiSurveyCapGbp: 2,
  aiMonthlyCapGbp: 50,
  aiMonthlyAlertGbp: 40,
};

export function mapBusinessSettings(data: Record<string, unknown> | null | undefined): BusinessSettings {
  if (!data) return { ...DEFAULT_SETTINGS };
  const modelDefault = data.ai_model_default;
  const modelEscalation = data.ai_model_escalation;
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
    vatDefault: typeof data.vat_default === "boolean" ? data.vat_default : DEFAULT_SETTINGS.vatDefault,
    vatNumber: typeof data.vat_number === "string" ? data.vat_number.trim() : "",
    baseLocation: typeof data.base_location === "string" && data.base_location.trim()
      ? data.base_location.trim()
      : DEFAULT_BASE_LOCATION,
    defaultDeposit: Number(data.default_deposit ?? DEFAULT_SETTINGS.defaultDeposit) || DEFAULT_SETTINGS.defaultDeposit,
    googleReviewUrl: typeof data.google_review_url === "string"
      ? data.google_review_url.trim()
      : DEFAULT_SETTINGS.googleReviewUrl,
    cubicFillPct: Number(data.cubic_fill_pct ?? DEFAULT_SETTINGS.cubicFillPct) || DEFAULT_SETTINGS.cubicFillPct,
    cubicTransitFt3: Number(data.cubic_transit_ft3 ?? DEFAULT_SETTINGS.cubicTransitFt3) || DEFAULT_SETTINGS.cubicTransitFt3,
    cubicLutonFt3: Number(data.cubic_luton_ft3 ?? DEFAULT_SETTINGS.cubicLutonFt3) || DEFAULT_SETTINGS.cubicLutonFt3,
    cubic75tFt3: Number(data.cubic_75t_ft3 ?? DEFAULT_SETTINGS.cubic75tFt3) || DEFAULT_SETTINGS.cubic75tFt3,
    aiSurveyEnabled: data.ai_survey_enabled === true,
    aiGroundedReplayEnabled: data.ai_grounded_replay_enabled === true,
    aiModelDefault: isApprovedAiModelId(modelDefault) ? modelDefault : DEFAULT_SETTINGS.aiModelDefault,
    aiModelEscalation: isApprovedAiModelId(modelEscalation) ? modelEscalation : DEFAULT_SETTINGS.aiModelEscalation,
    aiSurveyCapGbp: Number(data.ai_survey_cap_gbp ?? DEFAULT_SETTINGS.aiSurveyCapGbp),
    aiMonthlyCapGbp: Number(data.ai_monthly_cap_gbp ?? DEFAULT_SETTINGS.aiMonthlyCapGbp),
    aiMonthlyAlertGbp: Number(data.ai_monthly_alert_gbp ?? DEFAULT_SETTINGS.aiMonthlyAlertGbp),
  };
}

/** Read the singleton settings row, falling back to defaults if absent. */
export async function getBusinessSettings(
  sb: SupabaseClient,
): Promise<BusinessSettings> {
  const { data } = await sb
    .from("business_settings")
    .select("estimator_fee, cost_fuel_per_mile, cost_fuel_75_per_mile, cost_labour_per_day, cost_box, cost_van_day, cost_transit_day, cost_75t, cost_misc, vat_default, vat_number, base_location, default_deposit, google_review_url, cubic_fill_pct, cubic_transit_ft3, cubic_luton_ft3, cubic_75t_ft3, ai_survey_enabled, ai_grounded_replay_enabled, ai_model_default, ai_model_escalation, ai_survey_cap_gbp, ai_monthly_cap_gbp, ai_monthly_alert_gbp")
    .eq("id", true)
    .maybeSingle();
  return mapBusinessSettings(data as Record<string, unknown> | null);
}
