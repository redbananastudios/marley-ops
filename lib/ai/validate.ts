import { z } from "zod";
import { catalogueItem } from "@/lib/cubic-catalogue";
import {
  catalogueCandidateSchema,
  coverageSchema,
  photoDetectionSchema,
  photoRoomAssessmentSchema,
  qualityFlagSchema,
  roomAssessmentSchema,
  segmentProposalSchema,
  videoDetectionSchema,
  type CatalogueCandidate,
  type Coverage,
  type QualityFlag,
  type SegmentProposal,
} from "@/lib/ai/survey-schema";

export type ReviewReason =
  | "unmatched-room"
  | "no-catalogue-match"
  | "big-item"
  | "uncertain-moving"
  | "high-qty"
  | "low-confidence";

export interface PersistedSurveySegment {
  id: string;
  modelRef: string;
  roomId: string | null;
  startS: number;
  endS: number;
}

export type VideoValidationContext =
  | { kind: "room_video"; roomId: string; durationS: number }
  | { kind: "import_video"; durationS: number; segments: PersistedSurveySegment[] };

export interface PhotoValidationContext {
  kind: "photo";
  roomId: string;
  photoCount: number;
}

export interface ValidatedRoomAssessment {
  coverage: Coverage;
  qualityFlags: QualityFlag[];
  /** Display-only. Never use free text to calculate contingency. */
  warningNotes: string[];
  proposedRooms?: SegmentProposal[];
}

export interface ValidatedVideoEvidence {
  kind: "video";
  timestampsS: number[];
  segmentId?: string;
}

export interface ValidatedPhotoEvidence {
  kind: "photo";
  photoIndex: number;
  box2d?: [number, number, number, number];
}

export interface ValidatedDetection<Evidence extends ValidatedVideoEvidence | ValidatedPhotoEvidence> {
  label: string;
  catalogueKey: string | null;
  catalogueCandidates: CatalogueCandidate[];
  qty: number;
  moving: "moving" | "staying" | "uncertain";
  flags: { dismantle: boolean; fragile: boolean };
  roomId: string | null;
  evidence: Evidence;
  narrationNote?: string;
  reviewReason: ReviewReason | null;
}

export interface ValidatedSurveyOutput<Evidence extends ValidatedVideoEvidence | ValidatedPhotoEvidence> {
  roomAssessment: ValidatedRoomAssessment;
  items: ValidatedDetection<Evidence>[];
  salvaged: boolean;
}

export type SurveyValidationResult<Evidence extends ValidatedVideoEvidence | ValidatedPhotoEvidence> =
  | { ok: true; data: ValidatedSurveyOutput<Evidence> }
  | { ok: false; error: string };

/* One conservative salvage attempt: unknown keys are stripped and numeric
 * strings are coerced. Semantic limits are applied below, on trusted code. */
const salvageCandidateSchema = catalogueCandidateSchema.extend({
  confidence: z.coerce.number().min(0).max(1),
});

const salvageSegmentSchema = segmentProposalSchema.extend({
  startS: z.coerce.number().min(0),
  endS: z.coerce.number().min(0),
});

const salvageRoomAssessmentSchema = roomAssessmentSchema.extend({
  coverage: coverageSchema,
  qualityFlags: z.array(qualityFlagSchema).max(6),
  proposedRooms: z.array(salvageSegmentSchema).max(20).optional(),
});

const salvageCommonItem = {
  label: z.string().max(80),
  catalogueCandidates: z.array(salvageCandidateSchema).max(3),
  qty: z.coerce.number().finite(),
  moving: z.enum(["moving", "staying", "uncertain"]),
  dismantleLikely: z.boolean(),
  fragileLikely: z.boolean(),
  narrationNote: z.string().max(200).optional(),
};

const salvageVideoDetectionSchema = z.object({
  roomAssessment: salvageRoomAssessmentSchema,
  items: z.array(z.object({
    ...salvageCommonItem,
    timestampsS: z.array(z.coerce.number().finite()).min(1).max(5),
    segmentRef: z.string().min(1).max(40).optional(),
  })).max(120),
});

const salvagePhotoDetectionSchema = z.object({
  roomAssessment: photoRoomAssessmentSchema,
  items: z.array(z.object({
    ...salvageCommonItem,
    photoIndex: z.coerce.number().finite(),
    box2d: z.tuple([
      z.coerce.number().min(0).max(1000),
      z.coerce.number().min(0).max(1000),
      z.coerce.number().min(0).max(1000),
      z.coerce.number().min(0).max(1000),
    ]).optional(),
  })).max(120),
});

function parseWithOneSalvage<T>(
  raw: unknown,
  primary: z.ZodType<T>,
  salvage: z.ZodType<T>,
): { ok: true; data: T; salvaged: boolean } | { ok: false } {
  const parsed = primary.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data, salvaged: false };
  const recovered = salvage.safeParse(raw);
  return recovered.success
    ? { ok: true, data: recovered.data, salvaged: true }
    : { ok: false };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function validCandidates(raw: CatalogueCandidate[]): CatalogueCandidate[] {
  const seen = new Set<string>();
  return raw.filter((candidate) => {
    if (!catalogueItem(candidate.key) || seen.has(candidate.key)) return false;
    seen.add(candidate.key);
    return true;
  });
}

function reviewReason(
  candidates: CatalogueCandidate[],
  qtyBeforeClamp: number,
  moving: "moving" | "staying" | "uncertain",
  unmatchedRoom: boolean,
): ReviewReason | null {
  if (unmatchedRoom) return "unmatched-room";
  if (candidates.length === 0) return "no-catalogue-match";
  if (candidates.some((candidate) => (catalogueItem(candidate.key)?.ft3 ?? 0) >= 80)) return "big-item";
  if (moving === "uncertain") return "uncertain-moving";
  if (qtyBeforeClamp > 5) return "high-qty";
  if (candidates[0].confidence < 0.8) return "low-confidence";
  return null;
}

function segmentsAreNonOverlapping(segments: PersistedSurveySegment[]): boolean {
  const sorted = [...segments].sort((a, b) => a.startS - b.startS || a.endS - b.endS);
  return sorted.every((segment, index) =>
    Number.isFinite(segment.startS) &&
    Number.isFinite(segment.endS) &&
    segment.endS > segment.startS &&
    (index === 0 || segment.startS >= sorted[index - 1].endS));
}

function proposedRoomsAreValid(rooms: SegmentProposal[] | undefined, durationS: number): boolean {
  if (!rooms) return true;
  const refs = new Set<string>();
  const sorted = [...rooms].sort((a, b) => a.startS - b.startS || a.endS - b.endS);
  return sorted.every((room, index) => {
    const valid = !refs.has(room.ref) &&
      room.endS > room.startS &&
      room.endS <= durationS &&
      (index === 0 || room.startS >= sorted[index - 1].endS);
    refs.add(room.ref);
    return valid;
  });
}

function segmentForItem(
  segments: PersistedSurveySegment[],
  segmentRef: string | undefined,
  timestampsS: number[],
): PersistedSurveySegment | null {
  if (!segmentRef || !segmentsAreNonOverlapping(segments)) return null;
  const matches = segments.filter((segment) =>
    segment.modelRef === segmentRef &&
    timestampsS.every((timestamp) => timestamp >= segment.startS && timestamp <= segment.endS));
  return matches.length === 1 && matches[0].roomId ? matches[0] : null;
}

export function validateVideoOutput(raw: unknown, context: VideoValidationContext): SurveyValidationResult<ValidatedVideoEvidence> {
  if (!Number.isFinite(context.durationS) || context.durationS <= 0) {
    return { ok: false, error: "Invalid video duration." };
  }
  const parsed = parseWithOneSalvage(raw, videoDetectionSchema, salvageVideoDetectionSchema);
  if (!parsed.ok) return { ok: false, error: "Malformed video analysis output." };
  if (!proposedRoomsAreValid(parsed.data.roomAssessment.proposedRooms, context.durationS)) {
    return { ok: false, error: "Invalid or overlapping room segments." };
  }

  const items = parsed.data.items.map((item) => {
    const qtyBeforeClamp = Math.trunc(item.qty);
    const qty = clamp(qtyBeforeClamp, 1, 50);
    const timestampsS = item.timestampsS.map((timestamp) => clamp(timestamp, 0, context.durationS));
    const candidates = validCandidates(item.catalogueCandidates);
    const segment = context.kind === "import_video"
      ? segmentForItem(context.segments, item.segmentRef, timestampsS)
      : null;
    const unmatchedRoom = context.kind === "import_video" && !segment;
    const roomId = context.kind === "room_video" ? context.roomId : segment?.roomId ?? null;
    return {
      label: item.label.trim(),
      catalogueKey: candidates[0]?.key ?? null,
      catalogueCandidates: candidates,
      qty,
      moving: item.moving,
      flags: { dismantle: item.dismantleLikely, fragile: item.fragileLikely },
      roomId,
      evidence: {
        kind: "video" as const,
        timestampsS,
        ...(segment ? { segmentId: segment.id } : {}),
      },
      ...(item.narrationNote?.trim() ? { narrationNote: item.narrationNote.trim() } : {}),
      reviewReason: reviewReason(candidates, qtyBeforeClamp, item.moving, unmatchedRoom),
    };
  });

  return {
    ok: true,
    data: {
      roomAssessment: parsed.data.roomAssessment,
      items,
      salvaged: parsed.salvaged,
    },
  };
}

export function validatePhotoOutput(raw: unknown, context: PhotoValidationContext): SurveyValidationResult<ValidatedPhotoEvidence> {
  if (!Number.isInteger(context.photoCount) || context.photoCount < 1) {
    return { ok: false, error: "Invalid photo count." };
  }
  const parsed = parseWithOneSalvage(raw, photoDetectionSchema, salvagePhotoDetectionSchema);
  if (!parsed.ok) return { ok: false, error: "Malformed photo analysis output." };
  if (parsed.data.items.some((item) => !Number.isInteger(item.photoIndex) || item.photoIndex < 0 || item.photoIndex >= context.photoCount)) {
    return { ok: false, error: "Photo analysis referenced an unknown image." };
  }

  const items = parsed.data.items.map((item) => {
    const qtyBeforeClamp = Math.trunc(item.qty);
    const candidates = validCandidates(item.catalogueCandidates);
    return {
      label: item.label.trim(),
      catalogueKey: candidates[0]?.key ?? null,
      catalogueCandidates: candidates,
      qty: clamp(qtyBeforeClamp, 1, 50),
      moving: item.moving,
      flags: { dismantle: item.dismantleLikely, fragile: item.fragileLikely },
      roomId: context.roomId,
      evidence: {
        kind: "photo" as const,
        photoIndex: item.photoIndex,
        ...(item.box2d ? { box2d: item.box2d } : {}),
      },
      ...(item.narrationNote?.trim() ? { narrationNote: item.narrationNote.trim() } : {}),
      reviewReason: reviewReason(candidates, qtyBeforeClamp, item.moving, false),
    };
  });

  return {
    ok: true,
    data: {
      roomAssessment: parsed.data.roomAssessment,
      items,
      salvaged: parsed.salvaged,
    },
  };
}
