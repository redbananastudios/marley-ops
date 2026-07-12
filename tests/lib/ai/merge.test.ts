import { describe, expect, it } from "vitest";
import { mergeResolvedDetections, type ResolvedDetection } from "@/lib/ai/merge";
import type { CubicLine } from "@/lib/cubic-survey";

const resolved = (over: Partial<ResolvedDetection> = {}): ResolvedDetection => ({
  id: "10000000-0000-4000-8000-000000000001",
  roomName: "Living room",
  catalogueKey: "living-space:sofa-2-seater",
  qty: 1,
  moving: "moving",
  flags: { fragile: false, dismantle: false },
  narrationNote: "Sofa is moving",
  ...over,
});

function ids() {
  let value = 1;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

describe("mergeResolvedDetections", () => {
  it("builds catalogue lines from server-owned title/category/volume and maps staying", () => {
    const result = mergeResolvedDetections([], [
      resolved({ moving: "staying", flags: { fragile: true, dismantle: false } }),
    ], ids());
    expect(result.added).toEqual([expect.objectContaining({
      key: "living-space:sofa-2-seater",
      title: "Sofa 2 seater",
      category: "living-space",
      unitFt3: 35,
      room: "Living room",
      source: "ai",
      flags: { fragile: true, dismantle: false, notMoving: true },
      aiDetectionIds: ["10000000-0000-4000-8000-000000000001"],
    })]);
  });

  it("keeps the same catalogue key as distinct room lines with stable ids", () => {
    const result = mergeResolvedDetections([], [
      resolved(),
      resolved({ id: "10000000-0000-4000-8000-000000000002", roomName: "Bedroom" }),
    ], ids());
    expect(result.added).toHaveLength(2);
    expect(new Set(result.added.map((line) => line.id)).size).toBe(2);
  });

  it("supports estimator-resolved custom items without trusting model volume", () => {
    const result = mergeResolvedDetections([], [resolved({
      catalogueKey: null,
      customItem: { title: "Large sculpture", category: "custom", unitFt3: 22.5 },
    })], ids());
    expect(result.added[0]).toMatchObject({
      key: "custom:00000000-0000-4000-8000-000000000001",
      id: "00000000-0000-4000-8000-000000000002",
      title: "Large sculpture",
      unitFt3: 22.5,
    });
  });

  it("is idempotent against existing and repeated detection ids", () => {
    const existing: CubicLine = {
      ...mergeResolvedDetections([], [resolved()], ids()).added[0],
    };
    const result = mergeResolvedDetections([existing], [
      resolved(),
      resolved(),
      resolved({ id: "10000000-0000-4000-8000-000000000002" }),
    ], ids());
    expect(result.added).toHaveLength(1);
    expect(result.skippedDetectionIds).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000001",
    ]);
  });
});
