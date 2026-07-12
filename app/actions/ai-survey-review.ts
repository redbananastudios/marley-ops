"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { computeContingency, type AiSurveyStatus, type ContingencyRoom } from "@/lib/ai/contingency";
import { findManualInventoryConflicts, type DetectionEvidence } from "@/lib/ai/dedup";
import { mergeResolvedDetections, type ResolvedDetection } from "@/lib/ai/merge";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { catalogueItem } from "@/lib/cubic-catalogue";
import { computeCubicTotals, sanitizeCubicLines } from "@/lib/cubic-survey";
import { createAdminClient } from "@/lib/supabase/admin";

type ReviewResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; conflict?: boolean; needsChoices?: ManualInventoryConflict[] };

export interface ManualInventoryConflict {
  detectionId: string;
  detectionLabel: string;
  lineId: string;
  existingTitle: string;
  room: string;
}

const uuid = z.string().uuid();
const flags = z.object({ dismantle: z.boolean(), fragile: z.boolean() });
const catalogueResolution = z.object({
  type: z.literal("catalogue"),
  catalogueKey: z.string().min(1).max(120),
  qty: z.number().int().min(1).max(999),
  moving: z.enum(["moving", "staying"]),
  flags,
});
const customResolution = z.object({
  type: z.literal("custom"),
  title: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(60),
  unitFt3: z.number().finite().min(0.1).max(2000),
  qty: z.number().int().min(1).max(999),
  moving: z.enum(["moving", "staying"]),
  flags,
});
const resolution = z.discriminatedUnion("type", [catalogueResolution, customResolution]);
const manualConflictChoices = z.array(z.object({ detectionId: uuid, choice: z.enum(["skip_ai", "separate"]) })).max(100);
const duplicateChoice = z.object({ choice: z.enum(["max", "sum", "distinct", "quantity"]), qty: z.number().int().min(1).max(999).optional() }).refine((value) => value.choice !== "quantity" || !!value.qty, "Enter the corrected quantity.");
const segmentAssignment = z.object({
  action: z.enum(["assign", "merge", "reject"]),
  roomId: z.string().uuid().optional(),
  newRoom: z.string().trim().min(1).max(60).optional(),
}).refine((value) => value.action === "reject" || !!value.roomId || !!value.newRoom, "Choose a room.");

export async function assignSegmentAction(
  segmentId: string,
  raw: z.input<typeof segmentAssignment>,
): Promise<ReviewResult<{ roomId: string | null; status: string; updatedAt: string }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(segmentId);
  const input = segmentAssignment.safeParse(raw);
  if (!id.success || !input.success) return { ok: false, error: "Choose where this proposed room belongs." };
  if (input.data.roomId && input.data.newRoom) return { ok: false, error: "Choose an existing room or create a new one, not both." };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("assign_ai_segment", {
    p_segment_id: id.data,
    p_action: input.data.action,
    p_room_id: input.data.roomId ?? null,
    p_new_room: input.data.newRoom ?? null,
    p_actor_id: actor.id,
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Could not assign the proposed room." };
  }
  const result = data as { roomId?: unknown; status?: unknown; updatedAt?: unknown };
  if (typeof result.status !== "string" || typeof result.updatedAt !== "string") {
    return { ok: false, error: "The room assignment returned an invalid result." };
  }
  return {
    ok: true,
    roomId: typeof result.roomId === "string" ? result.roomId : null,
    status: result.status,
    updatedAt: result.updatedAt,
  };
}

export async function resolveDuplicateGroupAction(
  detectionIds: string[],
  raw: z.input<typeof duplicateChoice>,
): Promise<ReviewResult<{ primaryId: string; rejectedIds: string[]; choice: string; updatedAt: string }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const ids = z.array(uuid).min(2).max(20).safeParse(detectionIds);
  const input = duplicateChoice.safeParse(raw);
  if (!ids.success || !input.success) return { ok: false, error: "Choose how the repeated sightings should be counted." };
  const { data, error } = await createAdminClient().rpc("resolve_ai_duplicate_group", {
    p_detection_ids: ids.data,
    p_choice: input.data.choice,
    p_qty: input.data.qty ?? null,
    p_actor_id: actor.id,
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "Could not resolve this duplicate group." };
  const value = data as { primaryId?: unknown; rejectedIds?: unknown; choice?: unknown; updatedAt?: unknown };
  if (typeof value.primaryId !== "string" || !Array.isArray(value.rejectedIds) || typeof value.choice !== "string" || typeof value.updatedAt !== "string") return { ok: false, error: "Duplicate resolution returned an invalid result." };
  return { ok: true, primaryId: value.primaryId, rejectedIds: value.rejectedIds.filter((id): id is string => typeof id === "string"), choice: value.choice, updatedAt: value.updatedAt };
}

export async function resolveDetectionAction(
  detectionId: string,
  raw: { state: "accepted" | "edited" | "rejected"; resolution?: z.input<typeof resolution> },
): Promise<ReviewResult<{ updatedAt: string }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(detectionId);
  const state = z.enum(["accepted", "edited", "rejected"]).safeParse(raw.state);
  if (!id.success || !state.success) return { ok: false, error: "Invalid item resolution." };
  const admin = createAdminClient();
  const { data: detection } = await admin
    .from("cubic_ai_detections")
    .select("id, survey_id, room_id, catalogue_key, qty, moving, flags, state, review_reason")
    .eq("id", id.data)
    .maybeSingle();
  if (!detection || detection.state === "merged") return { ok: false, error: "Item is no longer editable." };
  if (detection.review_reason === "seen-in-multiple-clips") return { ok: false, error: "Resolve the repeated sightings together before accepting this item." };

  let storedResolution: z.infer<typeof resolution> | null = null;
  if (state.data === "accepted") {
    if (!detection.catalogue_key || !catalogueItem(detection.catalogue_key) || detection.moving === "uncertain") {
      return { ok: false, error: "Choose the correct item and moving status first." };
    }
  } else if (state.data === "edited") {
    const parsed = resolution.safeParse(raw.resolution);
    if (!parsed.success) return { ok: false, error: "Check the corrected item details." };
    if (parsed.data.type === "catalogue" && !catalogueItem(parsed.data.catalogueKey)) {
      return { ok: false, error: "Choose an item from the Marley catalogue." };
    }
    storedResolution = parsed.data;
  }

  const { error } = await admin
    .from("cubic_ai_detections")
    .update({ state: state.data, resolution: storedResolution as never, review_reason: null })
    .eq("id", id.data)
    .neq("state", "merged");
  if (error) return { ok: false, error: "Could not save the item review." };
  const { data: updated } = await admin.from("cubic_surveys").update({
    last_ai_user_activity_at: new Date().toISOString(),
    updated_by: actor.id,
  }).eq("id", detection.survey_id).select("updated_at").single();
  if (!updated) return { ok: false, error: "Could not refresh the survey review token." };
  return { ok: true, updatedAt: updated.updated_at };
}

export async function acceptRoomDetectionsAction(
  roomId: string,
): Promise<ReviewResult<{ accepted: number; updatedAt: string }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(roomId);
  if (!id.success) return { ok: false, error: "Invalid room." };
  const admin = createAdminClient();
  const { data: room } = await admin.from("cubic_survey_rooms").select("survey_id").eq("id", id.data).maybeSingle();
  if (!room) return { ok: false, error: "Room not found." };
  const { data, error } = await admin
    .from("cubic_ai_detections")
    .update({ state: "accepted" })
    .eq("room_id", id.data)
    .eq("state", "proposed")
    .is("review_reason", null)
    .select("id");
  if (error) return { ok: false, error: "Could not accept the room items." };
  const { data: updated } = await admin.from("cubic_surveys").update({ last_ai_user_activity_at: new Date().toISOString(), updated_by: actor.id }).eq("id", room.survey_id).select("updated_at").single();
  if (!updated) return { ok: false, error: "Could not refresh the survey review token." };
  return { ok: true, accepted: data?.length ?? 0, updatedAt: updated.updated_at };
}

export async function setRoomManifestCompleteAction(
  surveyId: string,
  complete: boolean,
): Promise<ReviewResult<{ updatedAt: string }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(surveyId);
  if (!id.success || typeof complete !== "boolean") return { ok: false, error: "Invalid survey." };
  const admin = createAdminClient();
  const { count } = await admin.from("cubic_survey_rooms").select("id", { count: "exact", head: true }).eq("survey_id", id.data);
  if (complete && !count) return { ok: false, error: "Add at least one room first." };
  const { data: updated, error } = await admin.from("cubic_surveys").update({
    room_manifest_complete: complete,
    planning_ready: false,
    last_ai_user_activity_at: new Date().toISOString(),
    updated_by: actor.id,
  }).eq("id", id.data).select("updated_at").single();
  return error || !updated ? { ok: false, error: "Could not update the room checklist." } : { ok: true, updatedAt: updated.updated_at };
}

function resolvedDetection(row: {
  id: string; catalogue_key: string | null; qty: number; moving: string;
  flags: unknown; resolution: unknown; label: string;
}, roomName: string): ResolvedDetection {
  const saved = resolution.safeParse(row.resolution);
  if (saved.success) {
    const value = saved.data;
    return {
      id: row.id, roomName,
      catalogueKey: value.type === "catalogue" ? value.catalogueKey : null,
      ...(value.type === "custom" ? { customItem: { title: value.title, category: value.category, unitFt3: value.unitFt3 } } : {}),
      qty: value.qty, moving: value.moving, flags: value.flags,
    };
  }
  const parsedFlags = flags.safeParse(row.flags);
  if (!row.catalogue_key || !catalogueItem(row.catalogue_key) || row.moving === "uncertain") throw new Error("Unresolved item");
  return {
    id: row.id, roomName, catalogueKey: row.catalogue_key, qty: row.qty,
    moving: row.moving as "moving" | "staying",
    flags: parsedFlags.success ? parsedFlags.data : { dismantle: false, fragile: false },
  };
}

function resolvedCatalogueKey(row: { catalogue_key: string | null; resolution: unknown }): string | null {
  const saved = resolution.safeParse(row.resolution);
  if (saved.success) return saved.data.type === "catalogue" ? saved.data.catalogueKey : null;
  return row.catalogue_key;
}

export async function confirmAiItemsAction(
  surveyId: string,
  roomId: string,
  baseUpdatedAt: string,
  rawConflicts: z.input<typeof manualConflictChoices> = [],
): Promise<ReviewResult<{ totalFt3: number; contingencyPct: number; updatedAt: string }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const conflictChoices = manualConflictChoices.safeParse(rawConflicts);
  if (!uuid.safeParse(surveyId).success || !uuid.safeParse(roomId).success || !baseUpdatedAt || !conflictChoices.success) return { ok: false, error: "Invalid confirmation." };
  const admin = createAdminClient();
  const [{ data: survey }, { data: room }, { data: detections }] = await Promise.all([
    admin.from("cubic_surveys").select("id, lead_id, items, updated_at, ai_status, room_manifest_complete").eq("id", surveyId).maybeSingle(),
    admin.from("cubic_survey_rooms").select("id, name, status").eq("id", roomId).eq("survey_id", surveyId).maybeSingle(),
    admin.from("cubic_ai_detections").select("id, catalogue_key, qty, moving, flags, resolution, label, state, evidence, review_reason, run:cubic_analysis_runs(media_id)").eq("survey_id", surveyId).eq("room_id", roomId),
  ]);
  if (!survey || !room) return { ok: false, error: "Survey room not found." };
  if (survey.updated_at !== baseUpdatedAt) return { ok: false, conflict: true, error: "The survey changed elsewhere. Reload and review again." };
  if (!survey.room_manifest_complete) return { ok: false, error: "Confirm that the room list is complete first." };
  const unresolved = (detections ?? []).filter((item) => item.state === "proposed");
  if (unresolved.length) return { ok: false, error: `Review all ${unresolved.length} remaining item${unresolved.length === 1 ? "" : "s"} first.` };
  const chosen = (detections ?? []).filter((item) => item.state === "accepted" || item.state === "edited");
  if (chosen.some((item) => item.review_reason === "seen-in-multiple-clips")) return { ok: false, error: "Resolve the repeated sightings before confirming this room." };

  try {
    const existing = sanitizeCubicLines(survey.items);
    if (!existing) throw new Error("Saved inventory is invalid");
    const manualConflicts = findManualInventoryConflicts(chosen.map((item) => ({
      id: item.id,
      mediaId: item.run?.media_id ?? "unknown",
      roomId,
      roomName: room.name,
      catalogueKey: resolvedCatalogueKey(item),
      qty: item.qty,
      evidence: item.evidence as DetectionEvidence,
    })), existing);
    const choiceByDetection = new Map(conflictChoices.data.map((choice) => [choice.detectionId, choice.choice]));
    const missingChoices: ManualInventoryConflict[] = manualConflicts.filter((conflict) => !choiceByDetection.has(conflict.detectionId)).map((conflict) => {
      const detection = chosen.find((item) => item.id === conflict.detectionId)!;
      const line = existing.find((item) => item.id === conflict.lineId)!;
      return { detectionId: conflict.detectionId, detectionLabel: detection.label, lineId: conflict.lineId, existingTitle: line.title, room: room.name };
    });
    if (missingChoices.length) return { ok: false, error: "Choose whether each AI sighting is already counted manually.", needsChoices: missingChoices };
    const mergeChosen = chosen.filter((item) => choiceByDetection.get(item.id) !== "skip_ai");
    const merged = mergeResolvedDetections(existing, mergeChosen.map((item) => resolvedDetection(item, room.name)));
    const totals = computeCubicTotals(merged.lines);
    const { data: allRooms } = await admin.from("cubic_survey_rooms").select("id, status, coverage, quality_flags, hidden_storage_checked, completion_method").eq("survey_id", surveyId);
    const { count: unresolvedCount } = await admin.from("cubic_ai_detections").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).eq("state", "proposed").neq("room_id", roomId);
    const decision = computeContingency({
      aiStatus: survey.ai_status as AiSurveyStatus,
      rawFt3: totals.totalFt3,
      roomManifestComplete: true,
      rooms: (allRooms ?? []).map((item) => ({
        status: item.id === roomId ? "confirmed" : item.status,
        coverage: item.coverage,
        qualityFlags: item.quality_flags as never,
        hiddenStorageChecked: item.hidden_storage_checked,
        completionMethod: item.id === roomId ? "ai" : item.completion_method,
      })) as ContingencyRoom[],
      unresolved: { unmatched: unresolvedCount ?? 0, bigItem: 0, duplicate: 0 },
      wholePropertyImportUsed: false,
      correctedDetectionCount: mergeChosen.filter((item) => item.state === "edited").length,
      detectionCount: mergeChosen.length,
    });
    const { data: result, error } = await admin.rpc("confirm_ai_room", {
      p_survey_id: surveyId, p_room_id: roomId, p_base_updated_at: baseUpdatedAt,
      p_new_lines: merged.added as never, p_detection_ids: chosen.map((item) => item.id),
      p_total_ft3: totals.totalFt3, p_contingency_pct: decision.contingencyPct,
      p_planning_ready: decision.planningReady, p_actor_id: actor.id,
    });
    if (error || !result) {
      if (error?.code === "40001") return { ok: false, conflict: true, error: "The survey changed elsewhere. Reload and review again." };
      throw error ?? new Error("Confirmation failed");
    }
    if (survey.lead_id) revalidatePath(`/leads/${survey.lead_id}/cubic`);
    return { ok: true, totalFt3: Number(result.total_ft3), contingencyPct: result.contingency_pct, updatedAt: result.updated_at };
  } catch {
    return { ok: false, error: "One or more items still need correcting before this room can be confirmed." };
  }
}
