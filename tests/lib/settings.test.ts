import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mapBusinessSettings } from "@/lib/settings";

describe("mapBusinessSettings AI survey settings", () => {
  it("uses the locked safe defaults when the row is absent", () => {
    expect(mapBusinessSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({
      aiSurveyEnabled: false,
      aiGroundedReplayEnabled: false,
      aiModelDefault: "gemini-3.5-flash",
      aiModelEscalation: "gemini-3.5-flash",
      aiSurveyCapGbp: 2,
      aiMonthlyCapGbp: 50,
      aiMonthlyAlertGbp: 40,
    });
  });

  it("maps Postgres numeric strings and approved model choices", () => {
    expect(mapBusinessSettings({
      ai_survey_enabled: true,
      ai_grounded_replay_enabled: true,
      ai_model_default: "gemini-3.1-flash-lite",
      ai_model_escalation: "gemini-3.5-flash",
      ai_survey_cap_gbp: "3.50",
      ai_monthly_cap_gbp: "75.00",
      ai_monthly_alert_gbp: "60.00",
    })).toMatchObject({
      aiSurveyEnabled: true,
      aiGroundedReplayEnabled: true,
      aiModelDefault: "gemini-3.1-flash-lite",
      aiModelEscalation: "gemini-3.5-flash",
      aiSurveyCapGbp: 3.5,
      aiMonthlyCapGbp: 75,
      aiMonthlyAlertGbp: 60,
    });
  });

  it("rejects arbitrary model IDs and fails back to 3.5 Flash", () => {
    expect(mapBusinessSettings({
      ai_model_default: "gemini-unknown",
      ai_model_escalation: "attacker-model",
    })).toMatchObject({
      aiModelDefault: "gemini-3.5-flash",
      aiModelEscalation: "gemini-3.5-flash",
    });
  });
});
