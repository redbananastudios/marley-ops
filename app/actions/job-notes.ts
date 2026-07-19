"use server";

/**
 * Crew note actions (Peter, 2026-07-10 — crew highlight damage/issues with
 * notes + photos for internal records). Runs on the ADMIN client after auth
 * (crew are RLS-blocked from quotes but notes hang off appointments/leads,
 * and the anchors are resolved server-side so a note can't be pointed at the
 * wrong customer). Every note also lands on the lead's activity timeline so
 * the office sees damage reports where they already look.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMediaStore } from "@/lib/storage/media-store";
import type { MediaUploadTarget } from "@/lib/storage/media-store";
import { MAX_IMAGE_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_LABEL } from "@/lib/storage/upload-limits";
import { isValidJobPhotoPath, JOB_PHOTOS_BUCKET, validateJobNote } from "@/lib/job-notes";

/** Media store bound to the job-photos bucket (its own R2 key prefix). */
const jobPhotosStore = () => createMediaStore(process.env, { bucket: JOB_PHOTOS_BUCKET });

async function requireActiveProfile() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;
  const { data: prof } = await sb
    .from("profiles")
    .select("id, active, role, full_name")
    .eq("id", user.id)
    .single();
  if (!prof?.active) return null;
  return prof;
}

export async function addJobNoteAction(
  appointmentId: string,
  input: { body: string; photoPaths: string[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const v = validateJobNote(input.body ?? "", input.photoPaths ?? [], appointmentId);
  if (!v.ok) return v;

  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select("id, lead_id")
    .eq("id", appointmentId)
    .single();
  if (!appt) return { ok: false, error: "Job not found." };

  const { data: lead } = appt.lead_id
    ? await admin.from("leads").select("id, client_id").eq("id", appt.lead_id).single()
    : { data: null };

  // Prefer the staff record's name (what the office knows them as).
  const { data: staffRow } = await admin
    .from("staff")
    .select("full_name")
    .eq("profile_id", prof.id)
    .eq("is_active", true)
    .maybeSingle();
  const authorName = staffRow?.full_name ?? prof.full_name ?? "Crew";

  const { error } = await admin.from("job_notes").insert({
    appointment_id: appointmentId,
    lead_id: appt.lead_id,
    client_id: lead?.client_id ?? null,
    author_id: prof.id,
    author_name: authorName,
    body: v.body,
    photo_paths: v.photoPaths,
  } as never);
  if (error) return { ok: false, error: "Could not save the note — try again." };

  // Surface on the lead timeline so the office can't miss a damage report.
  if (appt.lead_id) {
    const photoBit = v.photoPaths.length
      ? ` (${v.photoPaths.length} photo${v.photoPaths.length === 1 ? "" : "s"})`
      : "";
    await admin.from("activities").insert({
      lead_id: appt.lead_id,
      client_id: lead?.client_id ?? null,
      actor_id: prof.id,
      type: "note",
      summary: `Crew note from ${authorName}${photoBit}${v.body ? `: ${v.body.slice(0, 300)}` : ""}`,
      meta: { appointment_id: appointmentId, via: "crew_note" },
    });
    revalidatePath(`/leads/${appt.lead_id}`);
  }
  revalidatePath(`/my-jobs/${appointmentId}`);
  return { ok: true };
}

/** Bin a photo that was uploaded but never attached to a note (the crew
 *  changed their mind before saving). Storage deletes are admin-only at the
 *  RLS layer, so this runs on the service role after checking the path really
 *  belongs to the appointment folder the caller is working in. */
export async function discardJobPhotoAction(
  appointmentId: string,
  path: string,
): Promise<{ ok: boolean }> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false };
  const v = validateJobNote("x", [path], appointmentId);
  if (!v.ok) return { ok: false };
  // Never touch a photo a saved note already references.
  const admin = createAdminClient();
  const { data: claimed } = await admin
    .from("job_notes")
    .select("id")
    .contains("photo_paths", [path])
    .limit(1)
    .maybeSingle();
  if (claimed) return { ok: false };
  // Best-effort bin of an unattached object (an already-gone object is a
  // harmless no-op); never fail the discard on a storage hiccup.
  await jobPhotosStore()
    .deleteObjects([path])
    .catch(() => {});
  return { ok: true };
}

/** Remove a note (and its photos). Allowed for the note's author (fixing a
 *  mistake on the van tablet) or the office; notes are internal records, not
 *  signed evidence. The timeline activity entry deliberately stays. */
export async function deleteJobNoteAction(
  noteId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(noteId).success) return { ok: false, error: "Invalid note" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const admin = createAdminClient();
  const { data: note } = await admin
    .from("job_notes")
    .select("id, author_id, lead_id, appointment_id, photo_paths")
    .eq("id", noteId)
    .single();
  if (!note) return { ok: true }; // already gone

  const isOffice = prof.role === "admin" || prof.role === "estimator";
  if (!isOffice && note.author_id !== prof.id) {
    return { ok: false, error: "Only the note's author or the office can remove it." };
  }

  if (note.photo_paths?.length) {
    // Photo removal stays best-effort (matches the prior behaviour) so a
    // storage hiccup can't strand the note row; deleteObjects is idempotent.
    await jobPhotosStore()
      .deleteObjects(note.photo_paths)
      .catch(() => {});
  }
  const { error } = await admin.from("job_notes").delete().eq("id", noteId);
  if (error) return { ok: false, error: "Could not remove the note — try again." };

  if (note.lead_id) revalidatePath(`/leads/${note.lead_id}`);
  if (note.appointment_id) revalidatePath(`/my-jobs/${note.appointment_id}`);
  return { ok: true };
}

/** Upload target for a crew-note photo via the media-store seam — a presigned
 *  PUT on R2 in prod, or a Supabase TUS target on the supabase driver (dev /
 *  rollback). The path is re-validated against THIS appointment's folder (the
 *  crew-notes security guard) before a target is minted, and the session token
 *  keeps the Supabase bucket RLS applying (the R2 driver embeds auth in the
 *  presigned URL and ignores it). The client then feeds the returned target to
 *  uploadToMediaTarget. */
export async function createJobPhotoUploadTargetAction(
  appointmentId: string,
  input: { path: string; mime: string; bytes?: number },
): Promise<{ ok: true; target: MediaUploadTarget } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const sb = await createClient();
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session?.access_token) return { ok: false, error: "Session expired — sign in again." };

  if (!isValidJobPhotoPath(input.path, appointmentId)) {
    return { ok: false, error: "Invalid upload path." };
  }
  // Size ceiling: reject an over-cap declared size, and bind the presigned PUT to
  // it (R2 then rejects any other Content-Length) so the browser can't exceed it.
  if (typeof input.bytes === "number" && (input.bytes <= 0 || input.bytes > MAX_IMAGE_UPLOAD_BYTES)) {
    return { ok: false, error: `That photo is too large — keep it under ${MAX_IMAGE_UPLOAD_LABEL}.` };
  }
  const contentType = input.mime?.startsWith("image/") ? input.mime : "image/jpeg";
  try {
    const target = await jobPhotosStore().createUploadTarget({
      objectKey: input.path,
      contentType,
      accessToken: session.access_token,
      sizeBytes: typeof input.bytes === "number" && input.bytes > 0 ? input.bytes : undefined,
    });
    return { ok: true, target };
  } catch {
    return { ok: false, error: "Storage is not configured." };
  }
}
