"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function ctx() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

/** Find the lead's latest survey, or create one. Returns the survey id. */
export async function ensureSurveyForLead(leadId: string) {
  const { sb, userId } = await ctx();
  const { data: existing } = await sb
    .from("surveys")
    .select("id")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true as const, surveyId: existing.id };

  const { data: lead } = await sb.from("leads").select("client_id").eq("id", leadId).single();
  const { data, error } = await sb
    .from("surveys")
    .insert({ lead_id: leadId, client_id: lead?.client_id ?? null, estimator_id: userId, status: "scheduled" })
    .select("id")
    .single();
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, surveyId: data.id };
}

export async function saveSurveyData(
  surveyId: string,
  leadId: string,
  surveyData: Record<string, unknown>,
  status?: "scheduled" | "completed" | "cancelled",
) {
  const { sb } = await ctx();
  const { error } = await sb
    .from("surveys")
    .update({ survey_data: surveyData as never, ...(status ? { status } : {}) })
    .eq("id", surveyId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true as const };
}

/** Record a photo row after the client has uploaded the file to the survey-photos bucket. */
export async function recordSurveyPhoto(
  surveyId: string,
  leadId: string,
  category: "access" | "large_items",
  storagePath: string,
  caption?: string,
) {
  const { sb, userId } = await ctx();
  const { error } = await sb.from("survey_photos").insert({
    survey_id: surveyId,
    category,
    storage_path: storagePath,
    caption: caption || null,
    uploaded_by: userId,
  });
  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true as const };
}

/** Remove a photo (DB row + storage object). Uses the service role so any staff can tidy up. */
export async function deleteSurveyPhoto(photoId: string, storagePath: string, leadId: string) {
  await ctx();
  const admin = createAdminClient();
  await admin.storage.from("survey-photos").remove([storagePath]);
  const { error } = await admin.from("survey_photos").delete().eq("id", photoId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true as const };
}
