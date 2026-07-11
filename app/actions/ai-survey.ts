"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";

import { requireOfficeProfile } from "@/lib/ai/auth";
import { createMediaStore, type MediaUploadTarget } from "@/lib/storage/media-store";
import { createAdminClient } from "@/lib/supabase/admin";

type ActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const uuid = z.string().uuid();
const roomName = z.string().trim().min(1).max(60);
const roomInput = z.object({
  name: roomName,
  roomType: z.string().trim().max(60).optional(),
  floor: z.string().trim().max(60).optional(),
  hiddenStorageChecked: z.boolean().default(false),
});
const consentInput = z.object({
  textVersion: z.string().trim().min(1).max(40),
  customerAgreed: z.literal(true),
  agreementMethod: z.enum(["verbal", "digital"]),
  acks: z.object({
    filming: z.literal(true),
    audio: z.literal(true),
    aiProcessing: z.literal(true),
    manualAlternative: z.literal(true),
  }),
});
const mediaInput = z.object({
  roomId: uuid.optional(),
  kind: z.enum(["room_video", "import_video", "photo"]),
  mime: z.enum([
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "image/jpeg",
    "image/png",
  ]),
  bytes: z.number().int().positive().max(524_288_000),
  durationS: z.number().finite().min(0).max(1200).optional(),
});
const frameInput = z.object({
  t: z.number().finite().min(0).max(1200),
  path: z.string().min(1).max(300),
});
const frameRequest = z.object({
  t: z.number().finite().min(0).max(1200),
  bytes: z.number().int().positive().max(307_200),
});

const EXTENSION_BY_MIME: Record<z.infer<typeof mediaInput>["mime"], string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
};

async function surveyContext(surveyId: string) {
  return createAdminClient()
    .from("cubic_surveys")
    .select("id, lead_id, client_id, ai_consent, ai_consent_withdrawn_at, ai_status")
    .eq("id", surveyId)
    .maybeSingle();
}

async function recordActivity(input: {
  leadId: string | null;
  clientId: string | null;
  actorId: string;
  summary: string;
  meta?: Record<string, unknown>;
}) {
  if (!input.leadId && !input.clientId) return;
  await createAdminClient().from("activities").insert({
    lead_id: input.leadId,
    client_id: input.clientId,
    actor_id: input.actorId,
    type: "note",
    summary: input.summary,
    meta: (input.meta ?? {}) as never,
  });
}

export async function saveAiConsentAction(
  surveyId: string,
  raw: z.input<typeof consentInput>,
): Promise<ActionResult> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(surveyId);
  const input = consentInput.safeParse(raw);
  if (!id.success || !input.success) return { ok: false, error: "Check the agreement details." };

  const { data: survey } = await surveyContext(id.data);
  if (!survey) return { ok: false, error: "Survey not found." };
  if (survey.ai_consent_withdrawn_at) {
    return { ok: false, error: "Agreement was withdrawn. Continue manually." };
  }
  if (survey.ai_consent) return { ok: true };

  const now = new Date().toISOString();
  const { error } = await createAdminClient()
    .from("cubic_surveys")
    .update({
      ai_consent: {
        ...input.data,
        witnessedBy: actor.id,
        witnessedAt: now,
      },
      ai_status: "active",
      last_ai_user_activity_at: now,
      updated_by: actor.id,
    })
    .eq("id", id.data)
    .is("ai_consent", null);
  if (error) return { ok: false, error: "Could not save the agreement." };
  await recordActivity({
    leadId: survey.lead_id,
    clientId: survey.client_id,
    actorId: actor.id,
    summary: "AI survey agreement recorded",
  });
  if (survey.lead_id) revalidatePath(`/leads/${survey.lead_id}/cubic`);
  return { ok: true };
}

export async function createRoomAction(
  surveyId: string,
  raw: z.input<typeof roomInput>,
): Promise<ActionResult<{ roomId: string }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(surveyId);
  const input = roomInput.safeParse(raw);
  if (!id.success || !input.success) return { ok: false, error: "Enter a room name." };
  const { data: survey } = await surveyContext(id.data);
  if (!survey) return { ok: false, error: "Survey not found." };
  if (!survey.ai_consent) return { ok: false, error: "Record the customer agreement first." };

  const admin = createAdminClient();
  const { data: last } = await admin
    .from("cubic_survey_rooms")
    .select("sort")
    .eq("survey_id", id.data)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: room, error } = await admin
    .from("cubic_survey_rooms")
    .insert({
      survey_id: id.data,
      name: input.data.name,
      room_type: input.data.roomType || null,
      floor: input.data.floor || null,
      hidden_storage_checked: input.data.hiddenStorageChecked,
      sort: (last?.sort ?? -1) + 1,
      created_by: actor.id,
    })
    .select("id")
    .single();
  if (error || !room) return { ok: false, error: "Could not add the room." };
  await admin.from("cubic_surveys").update({
    room_manifest_complete: false,
    planning_ready: false,
    last_ai_user_activity_at: new Date().toISOString(),
    updated_by: actor.id,
  }).eq("id", id.data);
  return { ok: true, roomId: room.id };
}

export async function registerMediaAction(
  surveyId: string,
  raw: z.input<typeof mediaInput>,
): Promise<ActionResult<{ mediaId: string; storagePath: string; upload: MediaUploadTarget }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(surveyId);
  const input = mediaInput.safeParse(raw);
  if (!id.success || !input.success) return { ok: false, error: "This file cannot be uploaded." };
  if (input.data.kind === "room_video" && (!input.data.roomId || (input.data.durationS ?? 0) > 120 || input.data.bytes > 52_428_800)) {
    return { ok: false, error: "Room clips must be under 2 minutes and 50 MB." };
  }
  if (input.data.kind === "photo" && input.data.bytes > 15_728_640) {
    return { ok: false, error: "Photos must be under 15 MB." };
  }

  const { data: survey } = await surveyContext(id.data);
  if (!survey?.ai_consent || survey.ai_consent_withdrawn_at || survey.ai_status === "abandoned") {
    return { ok: false, error: "AI capture is not permitted for this survey." };
  }
  const admin = createAdminClient();
  if (input.data.roomId) {
    const { data: room } = await admin
      .from("cubic_survey_rooms")
      .select("id")
      .eq("id", input.data.roomId)
      .eq("survey_id", id.data)
      .maybeSingle();
    if (!room) return { ok: false, error: "Room not found." };
  }

  const mediaId = randomUUID();
  const storagePath = `${id.data}/${mediaId}/source.${EXTENSION_BY_MIME[input.data.mime]}`;
  const { error } = await admin.from("cubic_survey_media").insert({
    id: mediaId,
    survey_id: id.data,
    room_id: input.data.roomId ?? null,
    kind: input.data.kind,
    storage_path: storagePath,
    mime: input.data.mime,
    bytes: input.data.bytes,
    duration_s: input.data.durationS ?? null,
    created_by: actor.id,
  });
  if (error) return { ok: false, error: "Could not prepare the upload." };

  try {
    const upload = createMediaStore().createUploadTarget({
      objectKey: storagePath,
      contentType: input.data.mime,
      accessToken: actor.accessToken,
    });
    return { ok: true, mediaId, storagePath, upload };
  } catch {
    await admin.from("cubic_survey_media").delete().eq("id", mediaId);
    return { ok: false, error: "Media storage is not configured." };
  }
}

export async function finalizeMediaUploadAction(
  mediaId: string,
  rawFrames: z.input<typeof frameInput>[],
): Promise<ActionResult> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(mediaId);
  const frames = z.array(frameInput).max(40).safeParse(rawFrames);
  if (!id.success || !frames.success) return { ok: false, error: "Frame evidence is invalid." };

  const admin = createAdminClient();
  const { data: media } = await admin
    .from("cubic_survey_media")
    .select("id, survey_id, storage_path, status, created_by, duration_s")
    .eq("id", id.data)
    .maybeSingle();
  if (!media || media.created_by !== actor.id || media.status !== "uploading") {
    return { ok: false, error: "Upload is not ready to finalise." };
  }
  const framePrefix = `${media.survey_id}/${media.id}/frames/`;
  if (frames.data.some((frame) => !frame.path.startsWith(framePrefix) || !/\/[0-9]{4,8}\.jpg$/.test(frame.path))) {
    return { ok: false, error: "Frame path is invalid." };
  }

  try {
    const store = createMediaStore();
    const source = await store.getObjectMetadata(media.storage_path);
    for (const frame of frames.data) {
      const metadata = await store.getObjectMetadata(frame.path);
      if (metadata.bytes > 307_200) throw new Error("frame too large");
    }
    const { error } = await admin.rpc("finalize_ai_media", {
      p_media_id: media.id,
      p_actor_id: actor.id,
      p_bytes: source.bytes,
      p_duration_s: media.duration_s ?? 0,
      p_frames: frames.data,
      p_prompt_version: "ai-survey-v1",
    });
    if (error) throw error;
  } catch {
    return { ok: false, error: "Upload verification failed. Retry from this screen." };
  }
  const kickUrl = process.env.AI_JOBS_KICK_URL;
  const kickSecret = process.env.SYNC_CRON_SECRET;
  if (kickUrl && kickSecret) {
    after(async () => {
      await fetch(kickUrl, {
        headers: { Authorization: `Bearer ${kickSecret}` },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    });
  }
  return { ok: true };
}

export async function createFrameUploadTargetsAction(
  mediaId: string,
  rawFrames: z.input<typeof frameRequest>[],
): Promise<ActionResult<{ frames: { t: number; path: string; upload: MediaUploadTarget }[] }>> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  const id = uuid.safeParse(mediaId);
  const frames = z.array(frameRequest).max(40).safeParse(rawFrames);
  if (!id.success || !frames.success) return { ok: false, error: "Frame evidence is invalid." };
  const { data: media } = await createAdminClient()
    .from("cubic_survey_media")
    .select("id, survey_id, status, created_by")
    .eq("id", id.data)
    .maybeSingle();
  if (!media || media.created_by !== actor.id || media.status !== "uploading") {
    return { ok: false, error: "Upload is not ready for frames." };
  }

  try {
    const store = createMediaStore();
    return {
      ok: true,
      frames: frames.data.map((frame, index) => {
        const timestamp = String(Math.round(frame.t * 10)).padStart(6, "0");
        const path = `${media.survey_id}/${media.id}/frames/${timestamp}${String(index).padStart(2, "0")}.jpg`;
        return {
          t: frame.t,
          path,
          upload: store.createUploadTarget({
            objectKey: path,
            contentType: "image/jpeg",
            accessToken: actor.accessToken,
          }),
        };
      }),
    };
  } catch {
    return { ok: false, error: "Media storage is not configured." };
  }
}
