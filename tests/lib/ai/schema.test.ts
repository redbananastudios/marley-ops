import { describe, expect, it } from "vitest";
import {
  photoDetectionSchema,
  segmentProposalSchema,
  videoDetectionSchema,
} from "@/lib/ai/survey-schema";

const videoItem = {
  label: "Dining table",
  catalogueCandidates: [{ key: "living-space:dining-table-medium", confidence: 0.9 }],
  qty: 1,
  moving: "moving" as const,
  dismantleLikely: true,
  fragileLikely: false,
  timestampsS: [2, 4],
  narrationNote: "Customer said it is moving",
};

describe("AI survey production schemas", () => {
  it("parses the locked video and whole-property segment field names", () => {
    const parsed = videoDetectionSchema.parse({
      roomAssessment: {
        coverage: "good",
        qualityFlags: [],
        warningNotes: [],
        proposedRooms: [{ ref: "kitchen-1", name: "Kitchen", startS: 0, endS: 12 }],
      },
      items: [{ ...videoItem, segmentRef: "kitchen-1" }],
    });
    expect(parsed.items[0].timestampsS).toEqual([2, 4]);
    expect(parsed.items[0].segmentRef).toBe("kitchen-1");
    expect(segmentProposalSchema.parse(parsed.roomAssessment.proposedRooms?.[0]).name).toBe("Kitchen");
  });

  it("keeps photo evidence separate and strips fabricated video evidence", () => {
    const parsed = photoDetectionSchema.parse({
      roomAssessment: { coverage: "partial", qualityFlags: ["occluded"], warningNotes: ["Chair partly hidden"] },
      items: [{
        ...videoItem,
        timestampsS: [99],
        segmentRef: "invented",
        photoIndex: 1,
        box2d: [0, 10, 50, 90],
      }],
    });
    expect(parsed.items[0]).not.toHaveProperty("timestampsS");
    expect(parsed.items[0]).not.toHaveProperty("segmentRef");
    expect(parsed.items[0].photoIndex).toBe(1);
  });

  it("enforces model-output bounds before the one permitted salvage pass", () => {
    const base = {
      roomAssessment: { coverage: "good", qualityFlags: [], warningNotes: [] },
      items: [videoItem],
    };
    expect(videoDetectionSchema.safeParse(base).success).toBe(true);
    expect(videoDetectionSchema.safeParse({ ...base, items: [{ ...videoItem, qty: 51 }] }).success).toBe(false);
    expect(videoDetectionSchema.safeParse({ ...base, items: [{ ...videoItem, timestampsS: [] }] }).success).toBe(false);
    expect(videoDetectionSchema.safeParse({
      ...base,
      roomAssessment: { coverage: "good", qualityFlags: ["invented"], warningNotes: [] },
    }).success).toBe(false);
    expect(photoDetectionSchema.safeParse({
      roomAssessment: { coverage: "good", qualityFlags: [], warningNotes: [] },
      items: [{ ...videoItem, timestampsS: undefined, photoIndex: 0, box2d: [-1, 0, 10, 10] }],
    }).success).toBe(false);
  });
});
