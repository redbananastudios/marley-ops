import { describe, expect, it } from "vitest";
import {
  computeContingency,
  type ContingencyInput,
  type ContingencyRoom,
} from "@/lib/ai/contingency";

const goodRoom = (over: Partial<ContingencyRoom> = {}): ContingencyRoom => ({
  status: "confirmed",
  coverage: "good",
  qualityFlags: [],
  hiddenStorageChecked: true,
  completionMethod: "ai",
  ...over,
});

const readyInput = (over: Partial<ContingencyInput> = {}): ContingencyInput => ({
  aiStatus: "complete",
  rawFt3: 850,
  roomManifestComplete: true,
  rooms: [goodRoom()],
  unresolved: { unmatched: 0, bigItem: 0, duplicate: 0 },
  wholePropertyImportUsed: false,
  correctedDetectionCount: 0,
  detectionCount: 10,
  ...over,
});

describe("computeContingency readiness", () => {
  it("awards 10% only to a fully confirmed good-quality survey", () => {
    expect(computeContingency(readyInput())).toEqual({
      contingencyPct: 10,
      planningReady: true,
      vehicleGuidanceAllowed: true,
      planningFt3: 935,
      blockedReasons: [],
    });
  });

  it.each([
    ["failed AI survey", { aiStatus: "failed" }, "survey-failed"],
    ["room manifest", { roomManifestComplete: false }, "room-manifest-incomplete"],
    ["declared rooms", { rooms: [] }, "no-rooms"],
    ["confirmed rooms", { rooms: [goodRoom({ status: "ready" })] }, "room-unconfirmed"],
    ["known AI coverage", { rooms: [goodRoom({ coverage: null })] }, "missing-coverage"],
    ["unmatched items", { unresolved: { unmatched: 1, bigItem: 0, duplicate: 0 } }, "unmatched-item"],
    ["big items", { unresolved: { unmatched: 0, bigItem: 1, duplicate: 0 } }, "big-item"],
    ["duplicate groups", { unresolved: { unmatched: 0, bigItem: 0, duplicate: 1 } }, "duplicate-item"],
  ] as const)("fails closed without %s", (_label, patch, reason) => {
    const result = computeContingency(readyInput(patch));
    expect(result.planningReady).toBe(false);
    expect(result.vehicleGuidanceAllowed).toBe(false);
    expect(result.contingencyPct).toBe(0);
    expect(result.planningFt3).toBe(850);
    expect(result.blockedReasons).toContain(reason);
  });

  it("preserves raw-volume guidance for manual-only and abandoned surveys", () => {
    for (const aiStatus of ["not_started", "abandoned"] as const) {
      expect(computeContingency(readyInput({ aiStatus, roomManifestComplete: false, rooms: [] }))).toEqual({
        contingencyPct: 0,
        planningReady: false,
        vehicleGuidanceAllowed: true,
        planningFt3: 850,
        blockedReasons: [],
      });
    }
  });
});

describe("computeContingency risk levels", () => {
  it.each([
    ["partial coverage", { rooms: [goodRoom({ coverage: "partial" })] }],
    ["moderate clutter", { rooms: [goodRoom({ qualityFlags: ["cluttered_moderate"] })] }],
    ["whole-property import", { wholePropertyImportUsed: true }],
    ["mixed manual completion", { rooms: [goodRoom({ coverage: null, completionMethod: "manual" })] }],
    ["unchecked hidden storage", { rooms: [goodRoom({ hiddenStorageChecked: false })] }],
    ["more than 10% corrected", { correctedDetectionCount: 2, detectionCount: 10 }],
  ] as const)("uses 20%% for %s", (_label, patch) => {
    const result = computeContingency(readyInput(patch));
    expect(result.contingencyPct).toBe(20);
    expect(result.planningFt3).toBe(1020);
    expect(result.planningReady).toBe(true);
  });

  it("keeps the exact 10% corrected boundary at 10% contingency", () => {
    expect(computeContingency(readyInput({ correctedDetectionCount: 1, detectionCount: 10 })).contingencyPct).toBe(10);
  });

  it.each([
    ["poor coverage", goodRoom({ coverage: "poor" })],
    ["heavy clutter", goodRoom({ qualityFlags: ["cluttered_heavy"] })],
  ])("uses 30%% for %s", (_label, room) => {
    const result = computeContingency(readyInput({ rooms: [room] }));
    expect(result.contingencyPct).toBe(30);
    expect(result.planningFt3).toBe(1105);
  });

  it("lets 30% risk take precedence over 20% risk", () => {
    const result = computeContingency(readyInput({
      rooms: [goodRoom({ coverage: "poor", hiddenStorageChecked: false })],
      wholePropertyImportUsed: true,
    }));
    expect(result.contingencyPct).toBe(30);
  });
});
