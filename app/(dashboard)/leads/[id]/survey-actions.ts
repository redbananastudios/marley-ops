"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMediaStore } from "@/lib/storage/media-store";
import type { MediaUploadTarget } from "@/lib/storage/media-store";
import {
  SURVEY_PHOTOS_BUCKET,
  isSurveyPhotoCategory,
  isValidSurveyPhotoPath,
  type SurveyPhotoCategory,
} from "@/lib/survey-photos";

/** Media store bound to the survey-photos logical bucket — its own R2 key
 *  prefix (or the Supabase survey-photos bucket on the supabase driver). */
const surveyPhotoStore = () => createMediaStore(process.env, { bucket: SURVEY_PHOTOS_BUCKET });

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

/** List a lead's survey photos (across its latest survey). Read-only; for the
 *  quote builder's in-step photo uploaders to hydrate what's already there. */
export async function loadSurveyPhotos(leadId: string) {
  const { sb } = await ctx();
  const { data: survey } = await sb
    .from("surveys")
    .select("id")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!survey) return { ok: true as const, photos: [] as { id: string; category: "access" | "large_items" | "cubic"; storage_path: string }[] };
  const { data } = await sb
    .from("survey_photos")
    .select("id, category, storage_path")
    .eq("survey_id", survey.id)
    .order("created_at", { ascending: true });
  return {
    ok: true as const,
    photos: (data ?? []) as { id: string; category: "access" | "large_items" | "cubic"; storage_path: string }[],
  };
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
  category: "access" | "large_items" | "cubic",
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
  // Service-role path — must not be callable anonymously (review, 2026-07-10).
  const { userId } = await ctx();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const admin = createAdminClient();
  // Best-effort object bin through the seam (follows the active driver — R2 in
  // prod). deleteObjects is idempotent (a missing object is a no-op) and throws
  // only on a real failure; the row still deletes either way, preserving the
  // original remove-and-don't-block behaviour.
  await surveyPhotoStore()
    .deleteObjects([storagePath])
    .catch(() => {});
  const { error } = await admin.from("survey_photos").delete().eq("id", photoId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true as const };
}

/** Mint a seam upload target for one survey photo (presigned PUT on R2 in prod,
 *  a Supabase TUS target on the supabase driver). The path is survey-anchored
 *  and re-validated here; the session token keeps the Supabase bucket's
 *  is_staff() RLS applying (the R2 driver embeds auth in the presigned URL and
 *  ignores it). Client then PUTs via uploadToMediaTarget. */
export async function createSurveyPhotoUploadTargetAction(
  surveyId: string,
  category: SurveyPhotoCategory,
  input: { path: string; mime: string },
): Promise<{ ok: true; target: MediaUploadTarget } | { ok: false; error: string }> {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session?.access_token) return { ok: false, error: "Session expired — sign in again." };

  if (!isSurveyPhotoCategory(category)) return { ok: false, error: "Invalid photo category." };
  if (!isValidSurveyPhotoPath(input.path, surveyId, category)) {
    return { ok: false, error: "Invalid upload path." };
  }
  // The survey must exist and be visible to this login (RLS-scoped read) before
  // a target is minted — a path can't point at a survey the caller can't reach.
  const { data: survey } = await sb.from("surveys").select("id").eq("id", surveyId).maybeSingle();
  if (!survey) return { ok: false, error: "Survey not found." };

  const contentType = input.mime && input.mime.startsWith("image/") ? input.mime : "image/jpeg";
  try {
    const target = await surveyPhotoStore().createUploadTarget({
      objectKey: input.path,
      contentType,
      accessToken: session.access_token,
    });
    return { ok: true, target };
  } catch {
    return { ok: false, error: "Storage is not configured." };
  }
}

/** Short-lived (1h) signed read URLs for survey photos, keyed by storage path.
 *  Replaces the old client-side createSignedUrl — signing must be server-side
 *  now the store lives behind the seam. Any signed-in staff may sign (mirrors
 *  the survey-photos is_staff() read policy — all staff see all survey photos);
 *  a failed sign drops that one path rather than the whole set. */
export async function signSurveyPhotoUrls(
  storagePaths: string[],
): Promise<{ ok: true; urls: Record<string, string> } | { ok: false; error: string }> {
  const { userId } = await ctx();
  if (!userId) return { ok: false as const, error: "Not signed in." };
  const paths = [...new Set(storagePaths)]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .slice(0, 100);
  const store = surveyPhotoStore();
  const entries = await Promise.all(
    paths.map(async (p) => {
      try {
        return [p, await store.createSignedGetUrl(p, 3600)] as const;
      } catch {
        return [p, null] as const;
      }
    }),
  );
  const urls: Record<string, string> = {};
  for (const [p, url] of entries) if (url) urls[p] = url;
  return { ok: true as const, urls };
}
