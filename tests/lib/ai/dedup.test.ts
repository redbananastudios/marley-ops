import { describe, expect, it } from "vitest";
import {
  collapseWithinRun,
  findManualInventoryConflicts,
  groupCrossMediaDuplicates,
  type DedupDetection,
} from "@/lib/ai/dedup";
import type { CubicLine } from "@/lib/cubic-survey";

const detection = (over: Partial<DedupDetection> = {}): DedupDetection => ({
  id: "d1",
  mediaId: "m1",
  roomId: "r1",
  roomName: "Bedroom 1",
  catalogueKey: "bedrooms:wardrobe-double",
  qty: 1,
  evidence: { kind: "video", timestampsS: [4] },
  ...over,
});

describe("collapseWithinRun", () => {
  it("collapses the same catalogue key only when evidence identifies the same sighting", () => {
    const result = collapseWithinRun([
      detection(),
      detection({ id: "d2", qty: 2 }),
      detection({ id: "d3", evidence: { kind: "video", timestampsS: [9] } }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ qty: 2, contributingDetectionIds: ["d1", "d2"] });
    expect(result[1].contributingDetectionIds).toEqual(["d3"]);
  });

  it("never collapses unmatched detections", () => {
    expect(collapseWithinRun([
      detection({ catalogueKey: null }),
      detection({ id: "d2", catalogueKey: null }),
    ])).toHaveLength(2);
  });
});

describe("groupCrossMediaDuplicates", () => {
  it("creates a blocking same-room/key group across media and proposes max quantity", () => {
    const groups = groupCrossMediaDuplicates([
      detection({ qty: 2 }),
      detection({ id: "d2", mediaId: "m2", qty: 3 }),
      detection({ id: "d3", mediaId: "m3", qty: 1 }),
    ]);
    expect(groups).toEqual([expect.objectContaining({
      roomId: "r1",
      catalogueKey: "bedrooms:wardrobe-double",
      detectionIds: ["d1", "d2", "d3"],
      proposedQty: 3,
      reviewReason: "seen-in-multiple-clips",
    })]);
  });

  it("never groups the same key across rooms or within one media file", () => {
    expect(groupCrossMediaDuplicates([
      detection(),
      detection({ id: "d2", roomId: "r2", roomName: "Bedroom 2", mediaId: "m2" }),
      detection({ id: "d3", mediaId: "m1" }),
    ])).toEqual([]);
  });
});

describe("findManualInventoryConflicts", () => {
  const manual: CubicLine = {
    id: "00000000-0000-4000-8000-000000000001",
    key: "bedrooms:wardrobe-double",
    title: "Wardrobe double",
    category: "bedrooms",
    qty: 1,
    unitFt3: 40,
    room: " Bedroom 1 ",
  };

  it("matches catalogue key plus normalized exact room label", () => {
    expect(findManualInventoryConflicts([detection({ roomName: "bedroom 1" })], [manual])).toEqual([
      { detectionId: "d1", lineId: manual.id },
    ]);
    expect(findManualInventoryConflicts([detection({ roomName: "Bedroom 2" })], [manual])).toEqual([]);
  });
});
