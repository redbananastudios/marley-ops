import { describe, expect, it } from "vitest";

import { getSurveyPlanningState } from "@/lib/ai/planning";

describe("getSurveyPlanningState", () => {
  it("keeps manual and abandoned surveys on raw guidance", () => {
    expect(getSurveyPlanningState({ rawFt3: 100, aiStatus: "not_started", planningReady: false, contingencyPct: 30 })).toMatchObject({ planningFt3: 100, guidanceReady: true, aiInProgress: false });
    expect(getSurveyPlanningState({ rawFt3: 100, aiStatus: "abandoned", planningReady: false, contingencyPct: 0 })).toMatchObject({ planningFt3: 100, guidanceReady: true });
  });

  it("fails closed while an AI survey is incomplete", () => {
    expect(getSurveyPlanningState({ rawFt3: 850, aiStatus: "active", planningReady: false, contingencyPct: 0 })).toEqual({ rawFt3: 850, planningFt3: 850, contingencyPct: 0, guidanceReady: false, aiInProgress: true });
  });

  it("applies only approved persisted contingency when ready", () => {
    expect(getSurveyPlanningState({ rawFt3: 850, aiStatus: "complete", planningReady: true, contingencyPct: 10 })).toMatchObject({ planningFt3: 935, guidanceReady: true, contingencyPct: 10 });
    expect(getSurveyPlanningState({ rawFt3: 100, aiStatus: "complete", planningReady: true, contingencyPct: 17 })).toMatchObject({ planningFt3: 100, contingencyPct: 0 });
  });
});
