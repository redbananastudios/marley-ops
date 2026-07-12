import { describe, expect, it } from "vitest";
import { validatePhotoOutput, validateVideoOutput } from "@/lib/ai/validate";

const assessment = { coverage: "good", qualityFlags: [], warningNotes: [] };

const item = (over: Record<string, unknown> = {}) => ({
  label: "Dining chair",
  catalogueCandidates: [{ key: "living-space:dining-chairs", confidence: 0.8 }],
  qty: 5,
  moving: "moving",
  dismantleLikely: false,
  fragileLikely: false,
  timestampsS: [2],
  ...over,
});

const photoItem = (over: Record<string, unknown> = {}) => ({
  label: "Dining chair",
  catalogueCandidates: [{ key: "living-space:dining-chairs", confidence: 0.8 }],
  qty: 5,
  moving: "moving",
  dismantleLikely: false,
  fragileLikely: false,
  ...over,
});

describe("validateVideoOutput", () => {
  it("drops unknown candidates and all model-owned volume while retaining a blocking unmatched detection", () => {
    const result = validateVideoOutput({
      roomAssessment: assessment,
      items: [item({
        volume: 9999,
        unitFt3: 9999,
        catalogueCandidates: [{ key: "invented:sofa", confidence: 1, ft3: 9999 }],
      })],
    }, { kind: "room_video", roomId: "room-1", durationS: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      catalogueKey: null,
      catalogueCandidates: [],
      reviewReason: "no-catalogue-match",
    });
    expect(result.data.items[0]).not.toHaveProperty("volume");
    expect(result.data.items[0]).not.toHaveProperty("unitFt3");
  });

  it("pins auto-accept and review precedence at the exact boundaries", () => {
    const result = validateVideoOutput({
      roomAssessment: assessment,
      items: [
        item(),
        item({ catalogueCandidates: [{ key: "living-space:dining-chairs", confidence: 0.799 }] }),
        item({ qty: 6, catalogueCandidates: [{ key: "living-space:dining-chairs", confidence: 0.99 }] }),
        item({ moving: "uncertain", qty: 6 }),
        item({
          catalogueCandidates: [
            { key: "living-space:dining-chairs", confidence: 0.99 },
            { key: "kitchen-and-utility:fridge-freezer-american", confidence: 0.8 },
          ],
          moving: "uncertain",
          qty: 6,
        }),
      ],
    }, { kind: "room_video", roomId: "room-1", durationS: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.map((detection) => detection.reviewReason)).toEqual([
      null,
      "low-confidence",
      "high-qty",
      "uncertain-moving",
      "big-item",
    ]);
  });

  it("salvages numeric strings once, clamps quantity and timestamps, and strips unknown fields", () => {
    const result = validateVideoOutput({
      roomAssessment: assessment,
      items: [item({ qty: "99", timestampsS: ["-3", "12"], secret: "discard" })],
    }, { kind: "room_video", roomId: "room-1", durationS: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.salvaged).toBe(true);
    expect(result.data.items[0].qty).toBe(50);
    expect(result.data.items[0].evidence.timestampsS).toEqual([0, 10]);
    expect(result.data.items[0].reviewReason).toBe("high-qty");
    expect(result.data.items[0]).not.toHaveProperty("secret");
  });

  it("maps whole-property evidence to exactly one persisted non-overlapping segment", () => {
    const segments = [
      { id: "seg-1", modelRef: "bedroom", roomId: "room-1", startS: 0, endS: 10 },
      { id: "seg-2", modelRef: "kitchen", roomId: "room-2", startS: 10, endS: 20 },
    ];
    const result = validateVideoOutput({
      roomAssessment: assessment,
      items: [
        item({ segmentRef: "kitchen", timestampsS: [12] }),
        item({ segmentRef: "missing", timestampsS: [12] }),
      ],
    }, { kind: "import_video", durationS: 20, segments });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      roomId: "room-2",
      evidence: { kind: "video", segmentId: "seg-2", timestampsS: [12] },
      reviewReason: null,
    });
    expect(result.data.items[1]).toMatchObject({ roomId: null, reviewReason: "unmatched-room" });
  });

  it("preserves an unassigned persisted segment as blocking evidence", () => {
    const result = validateVideoOutput({
      roomAssessment: assessment,
      items: [item({ segmentRef: "kitchen", timestampsS: [12] })],
    }, {
      kind: "import_video",
      durationS: 20,
      segments: [{ id: "seg-2", modelRef: "kitchen", roomId: null, startS: 10, endS: 20 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      roomId: null,
      evidence: { kind: "video", segmentId: "seg-2", timestampsS: [12] },
      reviewReason: "unmatched-room",
    });
  });

  it("fails malformed/overlapping proposed segments before detections can persist", () => {
    const result = validateVideoOutput({
      roomAssessment: {
        ...assessment,
        proposedRooms: [
          { ref: "one", name: "One", startS: 0, endS: 8 },
          { ref: "two", name: "Two", startS: 7, endS: 10 },
        ],
      },
      items: [item()],
    }, { kind: "import_video", durationS: 10, segments: [] });
    expect(result).toEqual({ ok: false, error: "Invalid or overlapping room segments." });
  });
});

describe("validatePhotoOutput", () => {
  it("persists only validated photo evidence and never fabricates a timestamp", () => {
    const result = validatePhotoOutput({
      roomAssessment: assessment,
      items: [photoItem({ photoIndex: 1, box2d: [0, 10, 50, 90], timestampsS: [4] })],
    }, { kind: "photo", roomId: "room-1", photoCount: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0].evidence).toEqual({ kind: "photo", photoIndex: 1, box2d: [0, 10, 50, 90] });
    expect(result.data.items[0].evidence).not.toHaveProperty("timestampsS");
  });

  it("fails closed when the model references a photo outside the submitted list", () => {
    const result = validatePhotoOutput({
      roomAssessment: assessment,
      items: [photoItem({ photoIndex: 2 })],
    }, { kind: "photo", roomId: "room-1", photoCount: 2 });
    expect(result).toEqual({ ok: false, error: "Photo analysis referenced an unknown image." });
  });
});
