"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadJobSheet, loadPhotoDataUris } from "@/lib/job-sheet-load";
import type { JobSheetData } from "@/lib/job-sheet-docdef";

/** Everything the client-side pdfmake needs for one job's crew sheet.
 *
 *  Available to every active login — crew included (they print their own).
 *  Data loading + the price-free guarantee live in lib/job-sheet-load.ts
 *  (shared with the /my-jobs/[id] web view). */
export async function getJobSheetDataAction(
  appointmentId: string,
): Promise<{ ok: true; data: JobSheetData } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: prof } = await sb.from("profiles").select("active").eq("id", user.id).single();
  if (!prof?.active) return { ok: false, error: "Not signed in." };

  const admin = createAdminClient();
  const loaded = await loadJobSheet(admin, appointmentId);
  if (!loaded) return { ok: false, error: "Appointment not found." };

  loaded.data.photos = loaded.surveyId ? await loadPhotoDataUris(admin, loaded.surveyId) : [];
  return { ok: true, data: loaded.data };
}
