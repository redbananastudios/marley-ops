export type ContingencyPct = 0 | 10 | 20 | 30;

export type AiSurveyStatus = "not_started" | "active" | "ready" | "complete" | "abandoned" | "failed";
export type AiRoomStatus =
  | "pending"
  | "recording"
  | "uploading"
  | "processing"
  | "needs_attention"
  | "ready"
  | "confirmed"
  | "failed";
export type Coverage = "good" | "partial" | "poor";
export type QualityFlag =
  | "dark"
  | "fast_pan"
  | "blurred"
  | "cluttered_moderate"
  | "cluttered_heavy"
  | "occluded"
  | "incomplete_view"
  | "other";

export interface ContingencyRoom {
  status: AiRoomStatus;
  coverage: Coverage | null;
  qualityFlags: readonly QualityFlag[];
  hiddenStorageChecked: boolean;
  completionMethod: "ai" | "manual" | null;
}

export interface BlockingExceptions {
  unmatched: number;
  bigItem: number;
  duplicate: number;
}

export interface ContingencyInput {
  aiStatus: AiSurveyStatus;
  rawFt3: number;
  roomManifestComplete: boolean;
  rooms: readonly ContingencyRoom[];
  unresolved: BlockingExceptions;
  wholePropertyImportUsed: boolean;
  correctedDetectionCount: number;
  detectionCount: number;
}

export type ContingencyBlockReason =
  | "survey-failed"
  | "room-manifest-incomplete"
  | "no-rooms"
  | "room-unconfirmed"
  | "missing-coverage"
  | "unmatched-item"
  | "big-item"
  | "duplicate-item";

export interface ContingencyDecision {
  contingencyPct: ContingencyPct;
  planningReady: boolean;
  vehicleGuidanceAllowed: boolean;
  planningFt3: number;
  blockedReasons: ContingencyBlockReason[];
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function volume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value * 10) / 10);
}

function planningVolume(rawFt3: number, pct: ContingencyPct): number {
  return Math.round(rawFt3 * (1 + pct / 100) * 10) / 10;
}

/** Deterministic PRD 10/20/30 decision. No provider or database state is read here. */
export function computeContingency(input: ContingencyInput): ContingencyDecision {
  const rawFt3 = volume(input.rawFt3);

  // Manual-only and explicitly abandoned surveys preserve today's raw-volume guidance.
  if (input.aiStatus === "not_started" || input.aiStatus === "abandoned") {
    return {
      contingencyPct: 0,
      planningReady: false,
      vehicleGuidanceAllowed: true,
      planningFt3: rawFt3,
      blockedReasons: [],
    };
  }

  const blockedReasons: ContingencyBlockReason[] = [];
  if (input.aiStatus === "failed") blockedReasons.push("survey-failed");
  if (!input.roomManifestComplete) blockedReasons.push("room-manifest-incomplete");
  if (input.rooms.length === 0) blockedReasons.push("no-rooms");
  if (input.rooms.some((room) => room.status !== "confirmed")) blockedReasons.push("room-unconfirmed");
  if (input.rooms.some((room) => room.completionMethod !== "manual" && room.coverage === null)) {
    blockedReasons.push("missing-coverage");
  }
  if (count(input.unresolved.unmatched) > 0) blockedReasons.push("unmatched-item");
  if (count(input.unresolved.bigItem) > 0) blockedReasons.push("big-item");
  if (count(input.unresolved.duplicate) > 0) blockedReasons.push("duplicate-item");

  if (blockedReasons.length > 0) {
    return {
      contingencyPct: 0,
      planningReady: false,
      vehicleGuidanceAllowed: false,
      planningFt3: rawFt3,
      blockedReasons,
    };
  }

  const flags = new Set(input.rooms.flatMap((room) => [...room.qualityFlags]));
  const hasThirtyPctRisk = input.rooms.some((room) => room.coverage === "poor") || flags.has("cluttered_heavy");
  const corrected = count(input.correctedDetectionCount);
  const detections = count(input.detectionCount);
  const correctedOverTenPct = detections > 0 && corrected * 10 > detections;
  const hasTwentyPctRisk =
    input.rooms.some((room) => room.coverage === "partial") ||
    flags.has("cluttered_moderate") ||
    input.wholePropertyImportUsed ||
    input.rooms.some((room) => room.completionMethod === "manual") ||
    input.rooms.some((room) => !room.hiddenStorageChecked) ||
    correctedOverTenPct;
  const contingencyPct: ContingencyPct = hasThirtyPctRisk ? 30 : hasTwentyPctRisk ? 20 : 10;

  return {
    contingencyPct,
    planningReady: true,
    vehicleGuidanceAllowed: true,
    planningFt3: planningVolume(rawFt3, contingencyPct),
    blockedReasons: [],
  };
}
