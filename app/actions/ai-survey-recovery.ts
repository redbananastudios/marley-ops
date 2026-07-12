"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireOfficeProfile } from "@/lib/ai/auth";
import { estimateAiCallCost, gbpToUsd, isApprovedAiModelId } from "@/lib/ai/budget";
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
  const { data: current } = await admin.from("ai_jobs").select("status").eq("id", id.data).maybeSingle();
  if (current?.status === "blocked") return requeueBlockedAiJobAction(id.data);
  const { data: job, error } = await admin.rpc("retry_ai_job", { p_job_id: id.data, p_actor_id: actor.id });
  if (error || !job) return { ok: false, error: "This AI job cannot be retried yet." };
  await revalidateSurvey(job.survey_id);
  return { ok: true };
}

export async function requeueBlockedAiJobAction(jobId: string): Promise<Result> {
  const actor = await requireOfficeProfile();
  const id = uuid.safeParse(jobId);
  if (!actor) return { ok: false, error: "Office access required." };
  if (!id.success) return { ok: false, error: "Invalid AI job." };
  const admin = createAdminClient();
  const { data: job } = await admin.from("ai_jobs").select("id, survey_id, media_id, status, attempts").eq("id", id.data).maybeSingle();
  if (!job || job.status !== "blocked") return { ok: false, error: "This job is not blocked." };
  if (!job.media_id) return { ok: false, error: "This blocked job has no media to process." };
  const month = new Date().toISOString().slice(0, 7) + "-01";
  const [{ data: settings }, { data: monthSpend }, { data: reservations }, { data: media }] = await Promise.all([
    admin.from("business_settings").select("ai_survey_enabled, ai_survey_cap_gbp, ai_monthly_cap_gbp, ai_model_default, ai_model_escalation").eq("id", true).single(),
    admin.from("ai_spend_months").select("spent_usd, reserved_usd").eq("month", month).maybeSingle(),
    admin.from("ai_spend_reservations").select("status, estimated_usd, actual_usd").eq("survey_id", job.survey_id),
    admin.from("cubic_survey_media").select("duration_s").eq("id", job.media_id).maybeSingle(),
  ]);
  const surveyUsd = (reservations ?? []).reduce((sum, item) => sum + (item.status === "reserved" ? Number(item.estimated_usd) : item.status === "finalised" ? Number(item.actual_usd ?? 0) : 0), 0);
  const monthUsd = Number(monthSpend?.spent_usd ?? 0) + Number(monthSpend?.reserved_usd ?? 0);
  if (!settings?.ai_survey_enabled) return { ok: false, error: "Enable AI surveys before rechecking this job." };
  const configuredModel = job.attempts > 1 ? settings.ai_model_escalation : settings.ai_model_default;
  const model = isApprovedAiModelId(configuredModel) ? configuredModel : "gemini-3.5-flash";
  const estimate = estimateAiCallCost({ durationS: Math.max(Number(media?.duration_s ?? 1), 1), model }).estimatedCostUsd;
  if (surveyUsd + estimate > gbpToUsd(Number(settings.ai_survey_cap_gbp)) || monthUsd + estimate > gbpToUsd(Number(settings.ai_monthly_cap_gbp))) return { ok: false, error: "Raise the relevant spend cap before rechecking this job." };
  const { data: queued, error } = await admin.from("ai_jobs").update({ status: "queued", next_run_at: new Date().toISOString(), error: null }).eq("id", job.id).eq("status", "blocked").select("id").maybeSingle();
  if (error || !queued) return { ok: false, error: "The job changed before it could be requeued." };
  if (job.media_id) {
    const { data: media } = await admin.from("cubic_survey_media").update({ status: "uploaded", error: null }).eq("id", job.media_id).select("room_id").maybeSingle();
    if (media?.room_id) await admin.rpc("recompute_ai_room_state", { p_room_id: media.room_id });
  }
  await admin.from("cubic_surveys").update({ last_ai_user_activity_at: new Date().toISOString(), updated_by: actor.id }).eq("id", job.survey_id);
  const { data: survey } = await admin.from("cubic_surveys").select("client_id, lead_id").eq("id", job.survey_id).maybeSingle();
  if (survey?.client_id || survey?.lead_id) await admin.from("activities").insert({ client_id: survey.client_id, lead_id: survey.lead_id, actor_id: actor.id, type: "note", summary: "AI job requeued after spend control cleared", meta: { jobId: job.id } });
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

export async function completeRoomManuallyAction(
  surveyId: string,
  roomId: string,
  baseUpdatedAt: string,
): Promise<Result & { updatedAt?: string; conflict?: boolean }> {
  const actor = await requireOfficeProfile();
  const survey = uuid.safeParse(surveyId);
  const id = uuid.safeParse(roomId);
  if (!actor) return { ok: false, error: "Office access required." };
  if (!survey.success || !id.success || !baseUpdatedAt) return { ok: false, error: "Invalid room." };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("complete_ai_room_manually", { p_survey_id: survey.data, p_room_id: id.data, p_base_updated_at: baseUpdatedAt, p_actor_id: actor.id });
  if (error?.code === "40001") return { ok: false, conflict: true, error: "The survey changed elsewhere. Reload before finishing this room." };
  if (error || !data) return { ok: false, error: "Discard failed clips and resolve detected items before finishing this room manually." };
  await revalidateSurvey(survey.data);
  return { ok: true, updatedAt: data.updated_at };
}
