/**
 * Crew notes + photos (Peter, 2026-07-10) — free-form observations the crew
 * record against a job: damage found, access problems, anything worth an
 * internal photo record. Validators are pure (tested); the loaders run on the
 * ADMIN client because crew and office both read them and photos need signed
 * URLs from the private job-photos bucket. Internal-only: never on the job
 * sheet PDF, never emailed to the customer.
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export const JOB_PHOTOS_BUCKET = "job-photos";
export const MAX_NOTE_LENGTH = 2000;
export const MAX_PHOTOS_PER_NOTE = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_RE = /^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,80}\.(?:jpg|jpeg|png|webp|heic|heif)$/i;

/** A photo path is only acceptable when it sits under THIS appointment's
 *  folder — stops a note claiming files uploaded for another job. */
export function isValidJobPhotoPath(path: string, appointmentId: string): boolean {
  if (!UUID_RE.test(appointmentId)) return false;
  if (!PATH_RE.test(path)) return false;
  return path.toLowerCase().startsWith(`${appointmentId.toLowerCase()}/`);
}

/** Validate the note payload; returns the cleaned values or an error string. */
export function validateJobNote(
  body: string,
  photoPaths: string[],
  appointmentId: string,
): { ok: true; body: string; photoPaths: string[] } | { ok: false; error: string } {
  const cleanBody = body.trim().slice(0, MAX_NOTE_LENGTH);
  const paths = photoPaths.filter(Boolean);
  if (paths.length > MAX_PHOTOS_PER_NOTE) {
    return { ok: false, error: `A note can carry up to ${MAX_PHOTOS_PER_NOTE} photos.` };
  }
  if (paths.some((p) => !isValidJobPhotoPath(p, appointmentId))) {
    return { ok: false, error: "A photo didn't upload cleanly — remove it and try again." };
  }
  if (!cleanBody && paths.length === 0) {
    return { ok: false, error: "Write a note or add a photo first." };
  }
  return { ok: true, body: cleanBody, photoPaths: paths };
}

export interface JobNoteView {
  id: string;
  appointment_id: string | null;
  author_id: string | null;
  author_name: string;
  body: string;
  created_at: string;
  photos: { path: string; url: string }[];
}

interface JobNoteRow {
  id: string;
  appointment_id: string | null;
  author_id: string | null;
  author_name: string;
  body: string;
  photo_paths: string[];
  created_at: string;
}

const NOTE_COLUMNS = "id, appointment_id, author_id, author_name, body, photo_paths, created_at";

async function withSignedUrls(rows: JobNoteRow[]): Promise<JobNoteView[]> {
  const allPaths = [...new Set(rows.flatMap((r) => r.photo_paths ?? []))];
  const urlByPath = new Map<string, string>();
  if (allPaths.length) {
    // Sign each path through the media-store seam (R2 in prod, Supabase on the
    // supabase driver). A failed sign drops that one photo (filtered out below).
    // Lazy import: this module holds client-safe validators too and is imported
    // by client components, so the server-only seam must not load at module top.
    const { createMediaStore } = await import("@/lib/storage/media-store");
    const store = createMediaStore(process.env, { bucket: JOB_PHOTOS_BUCKET });
    await Promise.all(
      allPaths.map(async (path) => {
        try {
          urlByPath.set(path, await store.createSignedGetUrl(path, 3600));
        } catch {
          /* leave unsigned — the photo is dropped from the view below */
        }
      }),
    );
  }
  return rows.map((r) => ({
    id: r.id,
    appointment_id: r.appointment_id,
    author_id: r.author_id,
    author_name: r.author_name,
    body: r.body,
    created_at: r.created_at,
    photos: (r.photo_paths ?? [])
      .map((p) => ({ path: p, url: urlByPath.get(p) ?? "" }))
      .filter((p) => p.url),
  }));
}

/** Notes on one appointment (crew job page), oldest first. */
export async function loadJobNotesForAppointment(admin: Admin, appointmentId: string): Promise<JobNoteView[]> {
  const { data } = await admin
    .from("job_notes")
    .select(NOTE_COLUMNS)
    .eq("appointment_id", appointmentId)
    .order("created_at", { ascending: true });
  return withSignedUrls((data ?? []) as JobNoteRow[]);
}

/** Every crew note on a lead (office view), newest first. */
export async function loadJobNotesForLead(admin: Admin, leadId: string): Promise<JobNoteView[]> {
  const { data } = await admin
    .from("job_notes")
    .select(NOTE_COLUMNS)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });
  return withSignedUrls((data ?? []) as JobNoteRow[]);
}
