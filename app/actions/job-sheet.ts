"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { crewAssignedToAppointment, loadJobSheet, loadPhotoDataUris } from "@/lib/job-sheet-load";
import type { JobSheetData } from "@/lib/job-sheet-docdef";

/** Everything the client-side pdfmake needs for one job's crew sheet.
 *
 *  Office roles can pull any job's sheet; a CREW login only the jobs they are
 *  assigned to (same gate as the /my-jobs/[id] web view — the sheet carries
 *  customer PII, access notes, survey inventory and interior photos, so an
 *  unassigned crew member replaying this action must get nothing). Data
 *  loading + the price-free guarantee live in lib/job-sheet-load.ts. */
export async function getJobSheetDataAction(
  appointmentId: string,
): Promise<{ ok: true; data: JobSheetData } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: prof } = await sb
    .from("profiles")
    .select("active, role, email")
    .eq("id", user.id)
    .single();
  if (!prof?.active) return { ok: false, error: "Not signed in." };

  const admin = createAdminClient();
  if (prof.role === "crew") {
    const assigned = await crewAssignedToAppointment(admin, user.id, prof.email ?? null, appointmentId);
    if (!assigned) return { ok: false, error: "Appointment not found." };
  }
  const loaded = await loadJobSheet(admin, appointmentId);
  if (!loaded) return { ok: false, error: "Appointment not found." };

  loaded.data.photos = loaded.surveyId ? await loadPhotoDataUris(admin, loaded.surveyId) : [];
  return { ok: true, data: loaded.data };
}

/** The diary's job-summary panel — the same price-free crew brief WITHOUT the
 *  embedded photo data URIs (a modal fetch on every open must stay light), plus
 *  the accepted quote's id so the office can jump to the full quote. Same gate
 *  as the sheet above: office sees any job, crew only their own (the diary is
 *  an office surface, but the action must hold on its own). */
export async function getJobSummaryAction(
  appointmentId: string,
): Promise<{ ok: true; data: JobSheetData; quoteId: string | null } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: prof } = await sb
    .from("profiles")
    .select("active, role, email")
    .eq("id", user.id)
    .single();
  if (!prof?.active) return { ok: false, error: "Not signed in." };

  const admin = createAdminClient();
  if (prof.role === "crew") {
    const assigned = await crewAssignedToAppointment(admin, user.id, prof.email ?? null, appointmentId);
    if (!assigned) return { ok: false, error: "Appointment not found." };
  }
  const loaded = await loadJobSheet(admin, appointmentId);
  if (!loaded) return { ok: false, error: "Appointment not found." };
  return { ok: true, data: loaded.data, quoteId: loaded.quoteId };
}
