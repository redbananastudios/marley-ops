"use server";

/**
 * Job content capture actions (docs/job-content-capture-prd.md v1.0).
 * Crew/estimators capture on the job; the OFFICE approves before marketing use
 * (Peter, 2026-07-16: "I will initially approve things before posting").
 * Anchors resolve server-side (never trust the client's lead id when called
 * from a crew appointment) and every storage path is re-validated against the
 * lead — the job-notes security pattern.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  captureSummary,
  isValidJobMediaPath,
  JOB_MEDIA_BUCKET,
  JOB_MEDIA_TAGS,
  validateCaptureItems,
  type CaptureItemInput,
  type JobMediaTag,
} from "@/lib/job-media";

const uuid = z.string().uuid();

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

const isOffice = (role: string) => role === "admin" || role === "estimator";

/** Resolve the capture anchor: a lead id directly (office surfaces) or an
 *  appointment id (crew job page) — appointment wins server-side. */
async function resolveAnchor(
  admin: ReturnType<typeof createAdminClient>,
  anchor: { leadId?: string; appointmentId?: string },
): Promise<{ leadId: string; appointmentId: string | null; clientId: string | null; leadName: string | null; consent: string } | null> {
  if (anchor.appointmentId && uuid.safeParse(anchor.appointmentId).success) {
    const { data: appt } = await admin
      .from("appointments")
      .select("id, lead_id")
      .eq("id", anchor.appointmentId)
      .maybeSingle();
    if (!appt?.lead_id) return null;
    const { data: lead } = await admin
      .from("leads")
      .select("id, name, client_id, media_consent")
      .eq("id", appt.lead_id)
      .maybeSingle();
    if (!lead) return null;
    return {
      leadId: lead.id,
      appointmentId: appt.id,
      clientId: (lead.client_id as string | null) ?? null,
      leadName: (lead.name as string | null) ?? null,
      consent: (lead.media_consent as string) ?? "unset",
    };
  }
  if (anchor.leadId && uuid.safeParse(anchor.leadId).success) {
    const { data: lead } = await admin
      .from("leads")
      .select("id, name, client_id, media_consent")
      .eq("id", anchor.leadId)
      .maybeSingle();
    if (!lead) return null;
    return {
      leadId: lead.id,
      appointmentId: null,
      clientId: (lead.client_id as string | null) ?? null,
      leadName: (lead.name as string | null) ?? null,
      consent: (lead.media_consent as string) ?? "unset",
    };
  }
  return null;
}

/** The lead id the CLIENT should upload under — resolved server-side so the
 *  capture sheet on a crew appointment gets its true anchor before uploading. */
export async function getCaptureContextAction(anchor: {
  leadId?: string;
  appointmentId?: string;
}): Promise<
  | { ok: true; leadId: string; consent: string; captureCount: number }
  | { ok: false; error: string }
> {
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const admin = createAdminClient();
  const resolved = await resolveAnchor(admin, anchor);
  if (!resolved) return { ok: false, error: "Job not found." };
  const { count } = await admin
    .from("job_media")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", resolved.leadId);
  return { ok: true, leadId: resolved.leadId, consent: resolved.consent, captureCount: count ?? 0 };
}

export async function recordJobMediaAction(
  anchor: { leadId?: string; appointmentId?: string },
  items: CaptureItemInput[],
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };

  const admin = createAdminClient();
  const resolved = await resolveAnchor(admin, anchor);
  if (!resolved) return { ok: false, error: "Job not found." };

  const v = validateCaptureItems(items, resolved.leadId);
  if (!v.ok) return v;

  // Prefer the staff record's name (what the office knows them as).
  const { data: staffRow } = await admin
    .from("staff")
    .select("full_name")
    .eq("profile_id", prof.id)
    .eq("is_active", true)
    .maybeSingle();
  const authorName = staffRow?.full_name ?? prof.full_name ?? "Team";

  const consent = resolved.consent === "granted" ? "granted" : resolved.consent === "internal_only" ? "internal_only" : "unset";
  const rows = v.items.map((item) => ({
    lead_id: resolved.leadId,
    appointment_id: resolved.appointmentId,
    client_id: resolved.clientId,
    kind: item.kind,
    storage_path: item.path,
    mime: item.mime,
    bytes: item.bytes,
    duration_s: item.durationS,
    caption: item.caption,
    tag: item.tag,
    consent_state: consent,
    transcript_status: item.kind === "audio" ? "pending" : "none",
    captured_by: prof.id,
    captured_by_name: authorName,
  }));
  const { error } = await admin.from("job_media").insert(rows as never);
  if (error) return { ok: false, error: "Could not save — try again." };

  await admin.from("activities").insert({
    lead_id: resolved.leadId,
    client_id: resolved.clientId,
    actor_id: prof.id,
    type: "note",
    summary: `${authorName} captured ${captureSummary(v.items)} on the job`,
    meta: { via: "job_capture", appointment_id: resolved.appointmentId, count: v.items.length },
  });

  revalidatePath(`/leads/${resolved.leadId}`);
  if (resolved.appointmentId) revalidatePath(`/my-jobs/${resolved.appointmentId}`);
  revalidatePath("/content");
  return { ok: true, count: v.items.length };
}

/** Bin an uploaded-but-unrecorded object (tray remove before save). */
export async function discardJobMediaUploadAction(
  anchor: { leadId?: string; appointmentId?: string },
  path: string,
  kind: "photo" | "video" | "audio",
): Promise<{ ok: boolean }> {
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false };
  const admin = createAdminClient();
  const resolved = await resolveAnchor(admin, anchor);
  if (!resolved || !isValidJobMediaPath(path, resolved.leadId, kind)) return { ok: false };
  const { data: claimed } = await admin
    .from("job_media")
    .select("id")
    .eq("storage_path", path)
    .limit(1)
    .maybeSingle();
  if (claimed) return { ok: false }; // recorded rows are managed via delete
  await admin.storage.from(JOB_MEDIA_BUCKET).remove([path]);
  return { ok: true };
}

export async function updateJobMediaAction(
  id: string,
  patch: { caption?: string; tag?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid item" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("job_media")
    .select("id, lead_id, captured_by")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { ok: false, error: "Item not found." };
  if (!isOffice(prof.role) && row.captured_by !== prof.id) {
    return { ok: false, error: "Only the office or the person who captured it can edit." };
  }
  const tag =
    patch.tag === null || patch.tag === undefined
      ? patch.tag
      : JOB_MEDIA_TAGS.includes(patch.tag as JobMediaTag)
        ? patch.tag
        : undefined;
  const update: Record<string, unknown> = {};
  if (typeof patch.caption === "string") update.caption = patch.caption.trim().slice(0, 300);
  if (tag !== undefined) update.tag = tag;
  if (Object.keys(update).length === 0) return { ok: true };
  const { error } = await admin.from("job_media").update(update as never).eq("id", id);
  if (error) return { ok: false, error: "Could not save the change." };
  revalidatePath(`/leads/${row.lead_id}`);
  revalidatePath("/content");
  return { ok: true };
}

/** Per-job marketing consent (asked of the customer by whoever's on site).
 *  Only affects FUTURE captures — existing rows keep their birth stamp. */
export async function setLeadMediaConsentAction(
  anchor: { leadId?: string; appointmentId?: string },
  state: "granted" | "internal_only",
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (state !== "granted" && state !== "internal_only") return { ok: false, error: "Invalid state" };
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const admin = createAdminClient();
  const resolved = await resolveAnchor(admin, anchor);
  if (!resolved) return { ok: false, error: "Job not found." };
  const { error } = await admin
    .from("leads")
    .update({ media_consent: state } as never)
    .eq("id", resolved.leadId);
  if (error) return { ok: false, error: "Could not save." };
  await admin.from("activities").insert({
    lead_id: resolved.leadId,
    client_id: resolved.clientId,
    actor_id: prof.id,
    type: "note",
    summary:
      state === "granted"
        ? "Customer OK'd photos/video for marketing use"
        : "Job content set to internal-only (no marketing use)",
    meta: { via: "job_capture_consent" },
  });
  revalidatePath(`/leads/${resolved.leadId}`);
  return { ok: true };
}

/** OFFICE gate: nothing reaches marketing without this tap (Peter approves). */
export async function approveJobMediaAction(
  id: string,
  approve: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid item" };
  const prof = await requireActiveProfile();
  if (!prof || !isOffice(prof.role)) return { ok: false, error: "Office access required." };
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("job_media")
    .select("id, lead_id, consent_state")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { ok: false, error: "Item not found." };
  if (approve && row.consent_state === "internal_only") {
    return { ok: false, error: "This job's content is internal-only — the customer hasn't OK'd marketing use." };
  }
  const { error } = await admin
    .from("job_media")
    .update(
      (approve
        ? { marketing_approved_at: new Date().toISOString(), marketing_approved_by: prof.id }
        : { marketing_approved_at: null, marketing_approved_by: null, synced_at: null }) as never,
    )
    .eq("id", id);
  if (error) return { ok: false, error: "Could not update." };
  revalidatePath(`/leads/${row.lead_id}`);
  revalidatePath("/content");
  return { ok: true };
}

export async function deleteJobMediaAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid item" };
  const prof = await requireActiveProfile();
  if (!prof || !isOffice(prof.role)) return { ok: false, error: "Office access required." };
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("job_media")
    .select("id, lead_id, storage_path")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { ok: true };
  await admin.storage.from(JOB_MEDIA_BUCKET).remove([row.storage_path]);
  const { error } = await admin.from("job_media").delete().eq("id", id);
  if (error) return { ok: false, error: "Could not remove it — try again." };
  revalidatePath(`/leads/${row.lead_id}`);
  revalidatePath("/content");
  return { ok: true };
}

/** TUS resumable target for VIDEO (big files survive signal drops) — bucket
 *  job-media, path pre-validated; upload authenticated as the signed-in user
 *  so the bucket's staff RLS applies. */
export async function createJobMediaUploadTargetAction(
  anchor: { leadId?: string; appointmentId?: string },
  input: { path: string; mime: string },
): Promise<
  | {
      ok: true;
      target: {
        protocol: "tus";
        objectKey: string;
        endpoint: string;
        headers: Record<string, string>;
        metadata: Record<string, string>;
        chunkSizeBytes: number;
      };
    }
  | { ok: false; error: string }
> {
  const prof = await requireActiveProfile();
  if (!prof) return { ok: false, error: "Not signed in." };
  const sb = await createClient();
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session?.access_token) return { ok: false, error: "Session expired — sign in again." };

  const admin = createAdminClient();
  const resolved = await resolveAnchor(admin, anchor);
  if (!resolved || !isValidJobMediaPath(input.path, resolved.leadId, "video")) {
    return { ok: false, error: "Invalid upload path." };
  }
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "Storage is not configured." };
  return {
    ok: true,
    target: {
      protocol: "tus",
      objectKey: input.path,
      endpoint: `${base}/storage/v1/upload/resumable`,
      headers: { Authorization: `Bearer ${session.access_token}`, "x-upsert": "true" },
      metadata: {
        bucketName: JOB_MEDIA_BUCKET,
        objectName: input.path,
        contentType: input.mime || "video/mp4",
      },
      chunkSizeBytes: 6 * 1024 * 1024,
    },
  };
}
