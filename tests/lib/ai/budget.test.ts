import { describe, expect, it } from "vitest";
import {
  AI_MODEL_IDS,
  calculateAiCallCostUsd,
  checkAiBudget,
  DEFAULT_AI_MODEL,
  ECONOMY_AI_MODEL,
  estimateAiCallCost,
  gbpToUsd,
  isApprovedAiModelId,
  USD_PER_GBP,
} from "@/lib/ai/budget";

describe("AI model budget configuration", () => {
  it("locks the approved accuracy-first and economy models", () => {
    expect(AI_MODEL_IDS).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]);
    expect(DEFAULT_AI_MODEL).toBe("gemini-3.5-flash");
    expect(ECONOMY_AI_MODEL).toBe("gemini-3.1-flash-lite");
    expect(isApprovedAiModelId("gemini-3.5-flash")).toBe(true);
    expect(isApprovedAiModelId("gemini-3.1-flash-lite")).toBe(true);
    expect(isApprovedAiModelId("gemini-pro")).toBe(false);
    expect(isApprovedAiModelId(null)).toBe(false);
  });

  it("uses the conservative fixed GBP to USD conversion", () => {
    expect(USD_PER_GBP).toBe(1.4);
    expect(gbpToUsd(2)).toBe(2.8);
    expect(() => gbpToUsd(-1)).toThrow(RangeError);
  });
});

describe("estimateAiCallCost", () => {
  it("matches the PRD 12-minute default-model estimate", () => {
    expect(estimateAiCallCost({ durationS: 12 * 60 })).toEqual({
      model: "gemini-3.5-flash",
      inputTokens: 216_000,
      outputTokens: 3_000,
      estimatedCostUsd: 0.351,
    });
  });

  it("matches the economy-model estimate using the same token budget", () => {
    expect(estimateAiCallCost({ durationS: 12 * 60, model: ECONOMY_AI_MODEL })).toEqual({
      model: "gemini-3.1-flash-lite",
      inputTokens: 216_000,
      outputTokens: 3_000,
      estimatedCostUsd: 0.0585,
    });
  });

  it("ceil-reserves fractional video tokens and four-decimal USD", () => {
    expect(estimateAiCallCost({ durationS: 1.001, videoTokensPerSecond: 300, outputTokens: 0 })).toEqual({
      model: "gemini-3.5-flash",
      inputTokens: 301,
      outputTokens: 0,
      estimatedCostUsd: 0.0005,
    });
  });

  it("calculates actual usage at the model's input/output prices", () => {
    expect(calculateAiCallCostUsd(DEFAULT_AI_MODEL, 100_000, 2_000)).toBe(0.168);
    expect(calculateAiCallCostUsd(ECONOMY_AI_MODEL, 100_000, 2_000)).toBe(0.028);
  });

  it("rejects invalid cost inputs instead of weakening a reservation", () => {
    expect(() => estimateAiCallCost({ durationS: -1 })).toThrow(RangeError);
    expect(() => estimateAiCallCost({ durationS: Number.NaN })).toThrow(RangeError);
    expect(() => calculateAiCallCostUsd(DEFAULT_AI_MODEL, 1, -1)).toThrow(RangeError);
  });
});

describe("checkAiBudget", () => {
  const base = {
    estimatedCostUsd: 0.35,
    surveySpentUsd: 0,
    surveyReservedUsd: 0,
    monthlySpentUsd: 0,
    monthlyReservedUsd: 0,
    surveyCapGbp: 2,
    monthlyCapGbp: 50,
  };

  it("includes both spent and live reservations and allows the exact cap", () => {
    expect(checkAiBudget({ ...base, estimatedCostUsd: 0.3, surveySpentUsd: 2, surveyReservedUsd: 0.5 })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("blocks the survey cap before dispatch", () => {
    expect(checkAiBudget({ ...base, surveySpentUsd: 2.46 })).toEqual({
      allowed: false,
      reason: "budget_survey_cap",
    });
  });

  it("blocks the monthly cap when the survey still has room", () => {
    expect(checkAiBudget({ ...base, monthlySpentUsd: 69.5, monthlyReservedUsd: 0.2 })).toEqual({
      allowed: false,
      reason: "budget_monthly_cap",
    });
  });
});
