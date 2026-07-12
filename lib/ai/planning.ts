export interface SurveyPlanningState {
  rawFt3: number;
  planningFt3: number;
  contingencyPct: number;
  guidanceReady: boolean;
  aiInProgress: boolean;
}

/** Converts persisted survey state into the one volume allowed to drive vehicle planning. */
export function getSurveyPlanningState(input: {
  rawFt3: number;
  aiStatus: string | null | undefined;
  planningReady: boolean | null | undefined;
  contingencyPct: number | null | undefined;
}): SurveyPlanningState {
  const rawFt3 = Number.isFinite(input.rawFt3) && input.rawFt3 > 0 ? Math.round(input.rawFt3 * 10) / 10 : 0;
  const contingencyPct = [0, 10, 20, 30].includes(Number(input.contingencyPct)) ? Number(input.contingencyPct) : 0;
  const manual = !input.aiStatus || input.aiStatus === "not_started" || input.aiStatus === "abandoned";
  const guidanceReady = manual || input.planningReady === true;
  return {
    rawFt3,
    planningFt3: input.planningReady === true ? Math.round(rawFt3 * (1 + contingencyPct / 100) * 10) / 10 : rawFt3,
    contingencyPct,
    guidanceReady,
    aiInProgress: !manual && !input.planningReady,
  };
}
