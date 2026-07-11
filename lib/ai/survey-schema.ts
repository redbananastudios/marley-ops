import { z } from "zod";

/** Production Gemini contracts. Persist only values that survive these schemas. */
export const qualityFlagSchema = z.enum([
  "dark",
  "fast_pan",
  "blurred",
  "cluttered_moderate",
  "cluttered_heavy",
  "occluded",
  "incomplete_view",
  "other",
]);

export const coverageSchema = z.enum(["good", "partial", "poor"]);

export const segmentProposalSchema = z.object({
  ref: z.string().min(1).max(40),
  name: z.string().max(60),
  startS: z.number().min(0),
  endS: z.number().min(0),
});

export const roomAssessmentSchema = z.object({
  coverage: coverageSchema,
  qualityFlags: z.array(qualityFlagSchema).max(6),
  warningNotes: z.array(z.string().max(120)).max(6),
  proposedRooms: z.array(segmentProposalSchema).max(20).optional(),
});

export const catalogueCandidateSchema = z.object({
  key: z.string(),
  confidence: z.number().min(0).max(1),
});

export const videoItemSchema = z.object({
  label: z.string().max(80),
  catalogueCandidates: z.array(catalogueCandidateSchema).max(3),
  qty: z.number().int().min(1).max(50),
  moving: z.enum(["moving", "staying", "uncertain"]),
  dismantleLikely: z.boolean(),
  fragileLikely: z.boolean(),
  timestampsS: z.array(z.number().min(0)).min(1).max(5),
  segmentRef: z.string().min(1).max(40).optional(),
  narrationNote: z.string().max(200).optional(),
});

export const videoDetectionSchema = z.object({
  roomAssessment: roomAssessmentSchema,
  items: z.array(videoItemSchema).max(120),
});

export const photoRoomAssessmentSchema = roomAssessmentSchema.omit({ proposedRooms: true });

export const photoItemSchema = videoItemSchema.omit({ timestampsS: true, segmentRef: true }).extend({
  photoIndex: z.number().int().min(0),
  box2d: z.tuple([
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
    z.number().min(0).max(1000),
  ]).optional(),
});

export const photoDetectionSchema = z.object({
  roomAssessment: photoRoomAssessmentSchema,
  items: z.array(photoItemSchema).max(120),
});

export type QualityFlag = z.infer<typeof qualityFlagSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type SegmentProposal = z.infer<typeof segmentProposalSchema>;
export type RoomAssessment = z.infer<typeof roomAssessmentSchema>;
export type CatalogueCandidate = z.infer<typeof catalogueCandidateSchema>;
export type VideoItem = z.infer<typeof videoItemSchema>;
export type VideoDetectionOutput = z.infer<typeof videoDetectionSchema>;
export type PhotoItem = z.infer<typeof photoItemSchema>;
export type PhotoDetectionOutput = z.infer<typeof photoDetectionSchema>;
