"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { createMediaStore } from "@/lib/storage/media-store";
import type { MediaUploadTarget } from "@/lib/storage/media-store";
import {
  isValidDeclaredUploadSize,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_LABEL,
} from "@/lib/storage/upload-limits";
import {
  SURVEY_PHOTOS_BUCKET,
  SURVEY_PHOTO_CATEGORIES,
  isSurveyPhotoCategory,
  isValidSurveyPhotoPath,
  type SurveyPhotoCategory,
} from "@/lib/survey-photos";

/** Media store bound to the survey-photos logical bucket — its own R2 key
 *  prefix (or the Supabase survey-photos bucket on the supabase driver). */
const surveyPhotoStore = () => createMediaStore(process.env, { bucket: SURVEY_PHOTOS_BUCKET });

async function officeCtx() {
  const profile = await requireOfficeProfile();
  if (!profile) return null;
  const sb = await createClient();
  return { sb, userId: profile.id, accessToken: profile.accessToken };
}

/** Find the lead's latest survey, or create one. Returns the survey id. */
export async function ensureSurveyForLead(leadId: string) {
  const context = await officeCtx();
  if (!context) return { ok: false as const, error: "Office access required." };
  const { sb, userId } = context;
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

/**
 * Upper bound on the photos one lead's gallery will hydrate — PER CATEGORY.
 *
 * This read was unbounded, which was tolerable only while STAFF were the only
 * uploaders. A customer may now attach up to MAX_CUSTOMER_SURVEY_PHOTOS (20)
 * through their own /cv link, at up to MAX_IMAGE_UPLOAD_BYTES each, and
 * components/quote/survey-photos.tsx renders every returned row as a
 * full-resolution <img> — so an estimator opening /leads/<id>/cubic on a van
 * tablet over 4G could pull tens of megabytes before the page settled. The
 * bound is the row count; `loading="lazy"` on the tiles is what keeps the bytes
 * down for the ones nobody scrolls to.
 *
 * IT IS PER CATEGORY BECAUSE A LEAD-WIDE CAP STARVES A WIDGET. The first bound
 * was `created_at desc limit 60` over the whole lead, and the page renders THREE
 * widgets (access, large items, cubic) that each filter that one list client
 * side. Keeping the newest 60 lead-wide discards the OLDEST rows — and on a real
 * visit the access and large-item shots are taken FIRST, so a big cubic survey
 * plus twenty customer photos could push the access widget to render short, or
 * empty, while the office believed it was looking at everything. Capping each
 * category on its own is what makes one busy category unable to evict another.
 *
 * Within a category the read still takes the NEWEST rows and hands them back
 * oldest-first, which is the display order the widget appends to: ordering the
 * query ascending would make the cap drop the estimator's own photos — the ones
 * taken minutes ago, in the room they are standing in — in favour of customer
 * photos from a fortnight earlier.
 */
const MAX_GALLERY_PHOTOS_PER_CATEGORY = 40;

/** List a lead's survey photos (across its latest survey). Read-only; for the
 *  quote builder's in-step photo uploaders to hydrate what's already there.
 *
 *  Returns `totals` — the FULL row count per category, ignoring the cap — so the
 *  widget can say "showing N of M" instead of truncating silently. A gallery
 *  that hides rows while looking complete is the same defect as a read that
 *  fails and returns nothing.
 *
 *  Every read here is error-checked and reported. A rejected select must not
 *  reach the estimator as "this survey has no photos" — the office would decide
 *  it needed to re-shoot a survey it already has. */
export async function loadSurveyPhotos(leadId: string) {
  const context = await officeCtx();
  if (!context) return { ok: false as const, error: "Office access required." };
  const { sb } = context;
  const emptyTotals = Object.fromEntries(SURVEY_PHOTO_CATEGORIES.map((c) => [c, 0])) as Record<
    SurveyPhotoCategory,
    number
  >;
  const { data: survey, error: surveyError } = await sb
    .from("surveys")
    .select("id")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (surveyError) {
    return { ok: false as const, error: `Couldn’t load this lead’s survey: ${surveyError.message}` };
  }
  if (!survey) {
    return {
      ok: true as const,
      photos: [] as { id: string; category: SurveyPhotoCategory; storage_path: string }[],
      totals: emptyTotals,
    };
  }

  // One bounded read per category, in parallel — `count: "exact"` is computed
  // over the filtered set rather than the returned page, so it reports what the
  // cap is hiding.
  const perCategory = await Promise.all(
    SURVEY_PHOTO_CATEGORIES.map(async (category) => {
      const { data, error, count } = await sb
        .from("survey_photos")
        .select("id, category, storage_path", { count: "exact" })
        .eq("survey_id", survey.id)
        .eq("category", category)
        .order("created_at", { ascending: false })
        .limit(MAX_GALLERY_PHOTOS_PER_CATEGORY);
      return { category, data, error, count };
    }),
  );
  const failed = perCategory.find((r) => r.error);
  if (failed) {
    return {
      ok: false as const,
      error: `Couldn’t load the ${failed.category} photos: ${failed.error?.message ?? "read failed"}`,
    };
  }

  const photos: { id: string; category: SurveyPhotoCategory; storage_path: string }[] = [];
  const totals = { ...emptyTotals };
  for (const r of perCategory) {
    const rows = (r.data ?? []) as { id: string; category: SurveyPhotoCategory; storage_path: string }[];
    photos.push(...[...rows].reverse());
    totals[r.category] = r.count ?? rows.length;
  }
  return { ok: true as const, photos, totals };
}

export async function saveSurveyData(
  surveyId: string,
  leadId: string,
  surveyData: Record<string, unknown>,
  status?: "scheduled" | "completed" | "cancelled",
) {
  const context = await officeCtx();
  if (!context) return { ok: false as const, error: "Office access required." };
  const { sb } = context;
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
  const context = await officeCtx();
  if (!context) return { ok: false as const, error: "Office access required." };
  const { sb, userId } = context;
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

/** Remove a photo (DB row + storage object). Office-only because it uses the service role. */
export async function deleteSurveyPhoto(photoId: string, storagePath: string, leadId: string) {
  const context = await officeCtx();
  if (!context) return { ok: false as const, error: "Office access required." };
  const admin = createAdminClient();
  const { data: photo } = await admin
    .from("survey_photos")
    .select("id, storage_path")
    .eq("id", photoId)
    .maybeSingle();
  if (!photo?.storage_path || photo.storage_path !== storagePath) {
    return { ok: false as const, error: "Photo not found." };
  }
  // Delete the object FIRST through the seam (R2 in prod) and KEEP the row if it
  // fails, so a transient storage error can't strand customer imagery
  // (interior-of-home photos) as an orphan with no DB pointer — a GDPR-erasure
  // hygiene gap. deleteObjects is idempotent (an already-gone object is a no-op),
  // so a retry is safe. Mirrors deleteJobMediaAction.
  try {
    await surveyPhotoStore().deleteObjects([photo.storage_path]);
  } catch {
    return { ok: false as const, error: "Couldn’t remove the photo file — try again." };
  }
  const { error } = await admin
    .from("survey_photos")
    .delete()
    .eq("id", photoId)
    .eq("storage_path", photo.storage_path);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath(`/leads/${leadId}`);
  return { ok: true as const };
}

/** Mint a seam upload target for one survey photo (presigned PUT on R2 in prod,
 *  a Supabase TUS target on the supabase driver). The path is survey-anchored
 *  and re-validated here; the session token keeps the Supabase bucket's
 *  office RLS applying (the R2 driver embeds auth in the presigned URL and
 *  ignores it). Client then PUTs via uploadToMediaTarget. */
export async function createSurveyPhotoUploadTargetAction(
  surveyId: string,
  category: SurveyPhotoCategory,
  input: { path: string; mime: string; bytes: number },
): Promise<{ ok: true; target: MediaUploadTarget } | { ok: false; error: string }> {
  const context = await officeCtx();
  if (!context) return { ok: false, error: "Office access required." };
  const { sb, accessToken } = context;

  if (!isSurveyPhotoCategory(category)) return { ok: false, error: "Invalid photo category." };
  if (!isValidSurveyPhotoPath(input.path, surveyId, category)) {
    return { ok: false, error: "Invalid upload path." };
  }
  // Size ceiling: reject an over-cap declared size, and bind the presigned PUT to
  // it (R2 rejects any other Content-Length) so the browser can't exceed it.
  if (!isValidDeclaredUploadSize(input.bytes, MAX_IMAGE_UPLOAD_BYTES)) {
    return { ok: false, error: `That photo is too large — keep it under ${MAX_IMAGE_UPLOAD_LABEL}.` };
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
      accessToken,
      sizeBytes: input.bytes,
    });
    return { ok: true, target };
  } catch {
    return { ok: false, error: "Storage is not configured." };
  }
}

/** Short-lived (1h) signed read URLs for survey photos, keyed by storage path.
 *  Replaces the old client-side createSignedUrl — signing must be server-side
 *  now the store lives behind the seam. Office users may sign (matching the
 *  survey-photo office-only read policy);
 *  a failed sign drops that one path rather than the whole set. */
export async function signSurveyPhotoUrls(
  storagePaths: string[],
): Promise<{ ok: true; urls: Record<string, string> } | { ok: false; error: string }> {
  const context = await officeCtx();
  if (!context) return { ok: false as const, error: "Office access required." };
  const requested = [...new Set(storagePaths)]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .slice(0, 100);
  // Defence-in-depth: only sign paths that actually map to a survey_photos row, so
  // this can never mint a signed URL for an arbitrary object in the bucket.
  const admin = createAdminClient();
  const { data: known } = await admin.from("survey_photos").select("storage_path").in("storage_path", requested);
  const allowed = new Set((known ?? []).map((r) => r.storage_path));
  const paths = requested.filter((p) => allowed.has(p));
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
