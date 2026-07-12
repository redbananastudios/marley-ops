import type { CubicLine } from "@/lib/cubic-survey";

export type DetectionEvidence =
  | { kind: "video"; timestampsS: number[]; segmentId?: string }
  | { kind: "photo"; photoIndex: number };

export interface DedupDetection {
  id: string;
  mediaId: string;
  roomId: string | null;
  roomName: string;
  catalogueKey: string | null;
  qty: number;
  evidence: DetectionEvidence;
}

export interface CollapsedDetection extends DedupDetection {
  contributingDetectionIds: string[];
}

export interface CrossMediaDuplicateGroup {
  roomId: string;
  catalogueKey: string;
  detectionIds: string[];
  proposedQty: number;
  reviewReason: "seen-in-multiple-clips";
}

function evidenceKey(evidence: DetectionEvidence): string {
  if (evidence.kind === "photo") return `photo:${evidence.photoIndex}`;
  return `video:${evidence.segmentId ?? "room"}:${[...evidence.timestampsS].sort((a, b) => a - b).join(",")}`;
}

/** Collapse duplicate model rows only when they point to the same physical sighting. */
export function collapseWithinRun(detections: readonly DedupDetection[]): CollapsedDetection[] {
  const collapsed: CollapsedDetection[] = [];
  const indexBySignature = new Map<string, number>();
  for (const detection of detections) {
    const signature = detection.catalogueKey
      ? `${detection.roomId ?? "unassigned"}|${detection.catalogueKey}|${evidenceKey(detection.evidence)}`
      : `unmatched:${detection.id}`;
    const existingIndex = indexBySignature.get(signature);
    if (existingIndex === undefined) {
      indexBySignature.set(signature, collapsed.length);
      collapsed.push({ ...detection, contributingDetectionIds: [detection.id] });
      continue;
    }
    const existing = collapsed[existingIndex];
    existing.qty = Math.max(existing.qty, detection.qty);
    existing.contributingDetectionIds.push(detection.id);
  }
  return collapsed;
}

/** Cross-media matches are blocking suggestions, never silent merges. */
export function groupCrossMediaDuplicates(
  detections: readonly DedupDetection[],
): CrossMediaDuplicateGroup[] {
  const buckets = new Map<string, DedupDetection[]>();
  for (const detection of detections) {
    if (!detection.roomId || !detection.catalogueKey) continue;
    const key = `${detection.roomId}|${detection.catalogueKey}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(detection);
    buckets.set(key, bucket);
  }

  const groups: CrossMediaDuplicateGroup[] = [];
  for (const bucket of buckets.values()) {
    if (new Set(bucket.map((item) => item.mediaId)).size < 2) continue;
    groups.push({
      roomId: bucket[0].roomId!,
      catalogueKey: bucket[0].catalogueKey!,
      detectionIds: bucket.map((item) => item.id),
      proposedQty: Math.max(...bucket.map((item) => item.qty)),
      reviewReason: "seen-in-multiple-clips",
    });
  }
  return groups;
}

function normalizedRoom(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");
}

export function findManualInventoryConflicts(
  detections: readonly DedupDetection[],
  existingLines: readonly CubicLine[],
): { detectionId: string; lineId: string }[] {
  const conflicts: { detectionId: string; lineId: string }[] = [];
  for (const detection of detections) {
    if (!detection.catalogueKey) continue;
    const room = normalizedRoom(detection.roomName);
    for (const line of existingLines) {
      if (line.source === "ai") continue;
      if (line.key === detection.catalogueKey && normalizedRoom(line.room) === room) {
        conflicts.push({ detectionId: detection.id, lineId: line.id });
      }
    }
  }
  return conflicts;
}
