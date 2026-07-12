/** Pure AI cost and circuit-breaker maths. Database reservations remain atomic RPCs. */

export const AI_MODEL_IDS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"] as const;

export type AiModelId = (typeof AI_MODEL_IDS)[number];

export const DEFAULT_AI_MODEL: AiModelId = "gemini-3.5-flash";
export const ECONOMY_AI_MODEL: AiModelId = "gemini-3.1-flash-lite";
export const USD_PER_GBP = 1.4;
export const DEFAULT_VIDEO_TOKENS_PER_SECOND = 300;
export const DEFAULT_OUTPUT_TOKENS = 3_000;

export const AI_MODEL_PRICING_USD_PER_MILLION: Readonly<
  Record<AiModelId, { input: number; output: number }>
> = {
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
};

export function isApprovedAiModelId(value: unknown): value is AiModelId {
  return typeof value === "string" && (AI_MODEL_IDS as readonly string[]).includes(value);
}

function requireNonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
  return value;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Conservative four-decimal reservation matching the database numeric scale. */
function roundReservationUsd(value: number): number {
  return Math.ceil((value - Number.EPSILON) * 10_000) / 10_000;
}

export function calculateAiCallCostUsd(
  model: AiModelId,
  inputTokens: number,
  outputTokens: number,
): number {
  requireNonNegativeFinite(inputTokens, "inputTokens");
  requireNonNegativeFinite(outputTokens, "outputTokens");
  const price = AI_MODEL_PRICING_USD_PER_MILLION[model];
  return roundUsd((inputTokens * price.input + outputTokens * price.output) / 1_000_000);
}

export interface AiCallEstimateInput {
  durationS: number;
  model?: AiModelId;
  videoTokensPerSecond?: number;
  outputTokens?: number;
}

export interface AiCallEstimate {
  model: AiModelId;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/** PRD estimate: duration x 300 default-resolution tokens/s plus 3k output tokens. */
export function estimateAiCallCost(input: AiCallEstimateInput): AiCallEstimate {
  const durationS = requireNonNegativeFinite(input.durationS, "durationS");
  const videoTokensPerSecond = requireNonNegativeFinite(
    input.videoTokensPerSecond ?? DEFAULT_VIDEO_TOKENS_PER_SECOND,
    "videoTokensPerSecond",
  );
  const outputTokens = requireNonNegativeFinite(input.outputTokens ?? DEFAULT_OUTPUT_TOKENS, "outputTokens");
  const model = input.model ?? DEFAULT_AI_MODEL;
  const inputTokens = Math.ceil(durationS * videoTokensPerSecond);
  const estimatedCostUsd = roundReservationUsd(calculateAiCallCostUsd(model, inputTokens, outputTokens));
  return { model, inputTokens, outputTokens, estimatedCostUsd };
}

export function gbpToUsd(gbp: number): number {
  return roundUsd(requireNonNegativeFinite(gbp, "gbp") * USD_PER_GBP);
}

export type AiBudgetBlockReason = "budget_survey_cap" | "budget_monthly_cap";

export interface AiBudgetCheckInput {
  estimatedCostUsd: number;
  surveySpentUsd: number;
  surveyReservedUsd: number;
  monthlySpentUsd: number;
  monthlyReservedUsd: number;
  surveyCapGbp: number;
  monthlyCapGbp: number;
}

export type AiBudgetCheck =
  | { allowed: true; reason: null }
  | { allowed: false; reason: AiBudgetBlockReason };

/**
 * Pure mirror of the RPC's cap decision. The RPC is authoritative and locks rows;
 * this helper is useful for deterministic tests and user-facing previews only.
 */
export function checkAiBudget(input: AiBudgetCheckInput): AiBudgetCheck {
  const estimated = requireNonNegativeFinite(input.estimatedCostUsd, "estimatedCostUsd");
  const surveyTotal =
    requireNonNegativeFinite(input.surveySpentUsd, "surveySpentUsd") +
    requireNonNegativeFinite(input.surveyReservedUsd, "surveyReservedUsd") +
    estimated;
  const monthlyTotal =
    requireNonNegativeFinite(input.monthlySpentUsd, "monthlySpentUsd") +
    requireNonNegativeFinite(input.monthlyReservedUsd, "monthlyReservedUsd") +
    estimated;

  if (surveyTotal > gbpToUsd(input.surveyCapGbp)) {
    return { allowed: false, reason: "budget_survey_cap" };
  }
  if (monthlyTotal > gbpToUsd(input.monthlyCapGbp)) {
    return { allowed: false, reason: "budget_monthly_cap" };
  }
  return { allowed: true, reason: null };
}
