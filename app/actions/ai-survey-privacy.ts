"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireOfficeProfile } from "@/lib/ai/auth";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string };

export async function abandonAiSurveyAction(surveyId: string): Promise<Result> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  if (!z.string().uuid().safeParse(surveyId).success) return { ok: false, error: "Invalid survey." };
  const admin = createAdminClient();
  const { data: survey } = await admin.from("cubic_surveys").select("lead_id, client_id").eq("id", surveyId).maybeSingle();
  if (!survey) return { ok: false, error: "Survey not found." };
  const now = new Date().toISOString();
  const { error } = await admin.from("cubic_surveys").update({ ai_status: "abandoned", ai_abandoned_at: now, planning_ready: false, contingency_pct: 0, last_ai_user_activity_at: now, updated_by: actor.id }).eq("id", surveyId);
  if (error) return { ok: false, error: "Could not abandon AI assistance." };
  await admin.from("ai_jobs").update({ status: "cancelled", error: "AI survey abandoned", locked_by: null, locked_at: null, lease_expires_at: null }).eq("survey_id", surveyId).in("status", ["queued", "blocked"]);
  if (survey.lead_id || survey.client_id) await admin.from("activities").insert({ lead_id: survey.lead_id, client_id: survey.client_id, actor_id: actor.id, type: "note", summary: "AI assistance stopped for cubic survey", meta: { surveyId } });
  if (survey.lead_id) revalidatePath(`/leads/${survey.lead_id}/cubic`);
  return { ok: true };
}

export async function withdrawAiConsentAction(surveyId: string): Promise<Result> {
  const actor = await requireOfficeProfile();
  if (!actor) return { ok: false, error: "Office access required." };
  if (!z.string().uuid().safeParse(surveyId).success) return { ok: false, error: "Invalid survey." };
  const admin = createAdminClient();
  const { data: survey } = await admin.from("cubic_surveys").select("lead_id, client_id").eq("id", surveyId).maybeSingle();
  if (!survey) return { ok: false, error: "Survey not found." };
  const now = new Date().toISOString();
  const { error } = await admin.from("cubic_surveys").update({ ai_consent_withdrawn_at: now, ai_consent_withdrawn_by: actor.id, planning_ready: false, last_ai_user_activity_at: now, updated_by: actor.id }).eq("id", surveyId).is("ai_consent_withdrawn_at", null);
  if (error) return { ok: false, error: "Could not record the withdrawal." };
  await Promise.all([
    admin.from("ai_jobs").update({ status: "cancelled", error: "Customer withdrew AI agreement", locked_by: null, locked_at: null, lease_expires_at: null }).eq("survey_id", surveyId).in("status", ["queued", "blocked"]),
    admin.from("cubic_survey_media").update({ status: "deletion_pending", error: "Customer withdrew AI agreement" }).eq("survey_id", surveyId).in("status", ["uploading", "uploaded", "processing", "processed", "failed", "ignored"]),
  ]);
  if (survey.lead_id || survey.client_id) await admin.from("activities").insert({ lead_id: survey.lead_id, client_id: survey.client_id, actor_id: actor.id, type: "note", summary: "Customer withdrew AI survey agreement", meta: { surveyId } });
  if (survey.lead_id) revalidatePath(`/leads/${survey.lead_id}/cubic`);
  return { ok: true };
}
