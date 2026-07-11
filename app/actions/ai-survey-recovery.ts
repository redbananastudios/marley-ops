"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireOfficeProfile } from "@/lib/ai/auth";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string };
const uuid = z.string().uuid();

async function revalidateSurvey(surveyId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("cubic_surveys").select("lead_id").eq("id", surveyId).maybeSingle();
  if (data?.lead_id) {
    revalidatePath(`/leads/${data.lead_id}/cubic`);
    revalidatePath(`/leads/${data.lead_id}/cubic/review`);
  }
}

export async function retryAiJobAction(jobId: string): Promise<Result> {
  const actor = await requireOfficeProfile();
  const id = uuid.safeParse(jobId);
  if (!actor) return { ok: false, error: "Office access required." };
  if (!id.success) return { ok: false, error: "Invalid AI job." };
  const admin = createAdminClient();
  const { data: job, error } = await admin.rpc("retry_ai_job", { p_job_id: id.data, p_actor_id: actor.id });
  if (error || !job) return { ok: false, error: "This AI job cannot be retried yet." };
  await revalidateSurvey(job.survey_id);
  return { ok: true };
}

export async function ignoreFailedMediaAction(mediaId: string): Promise<Result> {
  const actor = await requireOfficeProfile();
  const id = uuid.safeParse(mediaId);
  if (!actor) return { ok: false, error: "Office access required." };
  if (!id.success) return { ok: false, error: "Invalid media item." };
  const admin = createAdminClient();
  const { data: media } = await admin.from("cubic_survey_media").select("survey_id").eq("id", id.data).maybeSingle();
  if (!media) return { ok: false, error: "Media item not found." };
  const { data, error } = await admin.rpc("ignore_failed_ai_media", { p_media_id: id.data, p_actor_id: actor.id });
  if (error || !data) return { ok: false, error: "Discard is available only after processing has stopped." };
  await revalidateSurvey(media.survey_id);
  return { ok: true };
}

export async function finishAiRoomManuallyAction(roomId: string): Promise<Result> {
  const actor = await requireOfficeProfile();
  const id = uuid.safeParse(roomId);
  if (!actor) return { ok: false, error: "Office access required." };
  if (!id.success) return { ok: false, error: "Invalid room." };
  const admin = createAdminClient();
  const { data: room } = await admin.from("cubic_survey_rooms").select("survey_id").eq("id", id.data).maybeSingle();
  if (!room) return { ok: false, error: "Room not found." };
  const { data, error } = await admin.rpc("finish_ai_room_manually", { p_room_id: id.data, p_actor_id: actor.id });
  if (error || !data) return { ok: false, error: "Discard failed clips before finishing this room manually." };
  await revalidateSurvey(room.survey_id);
  return { ok: true };
}
