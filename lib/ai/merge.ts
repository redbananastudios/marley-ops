import { catalogueItem } from "@/lib/cubic-catalogue";
import { createCubicLineId, type CubicLine, type CubicLineFlags } from "@/lib/cubic-survey";

export interface ResolvedCustomItem {
  title: string;
  category: string;
  unitFt3: number;
}

export interface ResolvedDetection {
  id: string;
  roomName: string;
  catalogueKey: string | null;
  customItem?: ResolvedCustomItem;
  qty: number;
  moving: "moving" | "staying";
  flags: Pick<CubicLineFlags, "dismantle" | "fragile">;
  narrationNote?: string;
}

export interface MergeResult {
  lines: CubicLine[];
  added: CubicLine[];
  skippedDetectionIds: string[];
}

function checkedQty(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 999) throw new RangeError("Invalid resolved quantity");
  return value;
}

/** Pure final conversion. The database transaction remains authoritative for concurrency. */
export function mergeResolvedDetections(
  existingLines: readonly CubicLine[],
  detections: readonly ResolvedDetection[],
  idFactory: () => string = createCubicLineId,
): MergeResult {
  const seenDetectionIds = new Set(existingLines.flatMap((line) => line.aiDetectionIds ?? []));
  const skippedDetectionIds: string[] = [];
  const added: CubicLine[] = [];

  for (const detection of detections) {
    if (seenDetectionIds.has(detection.id)) {
      skippedDetectionIds.push(detection.id);
      continue;
    }
    seenDetectionIds.add(detection.id);

    let key: string;
    let title: string;
    let category: string;
    let unitFt3: number;
    if (detection.catalogueKey) {
      const catalogue = catalogueItem(detection.catalogueKey);
      if (!catalogue) throw new RangeError(`Unknown catalogue key: ${detection.catalogueKey}`);
      key = catalogue.key;
      title = catalogue.title;
      category = catalogue.key.split(":", 1)[0];
      unitFt3 = catalogue.ft3;
    } else {
      const custom = detection.customItem;
      if (!custom || !custom.title.trim() || !custom.category.trim()) throw new RangeError("Unmatched detection needs a custom item");
      if (!Number.isFinite(custom.unitFt3) || custom.unitFt3 < 0 || custom.unitFt3 > 2_000) {
        throw new RangeError("Invalid custom item volume");
      }
      key = `custom:${idFactory()}`;
      title = custom.title.trim().slice(0, 120);
      category = custom.category.trim().slice(0, 60);
      unitFt3 = Math.round(custom.unitFt3 * 10) / 10;
    }

    added.push({
      id: idFactory(),
      key,
      title,
      category,
      qty: checkedQty(detection.qty),
      unitFt3,
      flags: {
        dismantle: detection.flags.dismantle === true,
        fragile: detection.flags.fragile === true,
        notMoving: detection.moving === "staying",
      },
      ...(detection.narrationNote?.trim() ? { note: detection.narrationNote.trim().slice(0, 300) } : {}),
      room: detection.roomName.trim().slice(0, 60),
      source: "ai",
      aiDetectionIds: [detection.id],
    });
  }

  return { lines: [...existingLines, ...added], added, skippedDetectionIds };
}
