"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleJobSheetData, type SheetLead, type SheetQuote } from "@/lib/job-sheet-data";
import type { JobSheetData, JobSheetPhoto } from "@/lib/job-sheet-docdef";

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 1_500_000;

/** Everything the client-side pdfmake needs for one job's crew sheet.
 *
 *  Available to every active login — crew included (they print their own) —
 *  which is exactly why the data access runs on the ADMIN client: crew are
 *  RLS-blocked from the quotes table (pricing lockdown), but the sheet needs
 *  the quote's inventory + addresses. assembleJobSheetData never emits money,
 *  so nothing price-shaped crosses the wire (test-enforced). */
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
  const { data: appt } = await admin
    .from("appointments")
    .select("id, title, starts_at, ends_at, all_day, appt_type, lead_id")
    .eq("id", appointmentId)
    .single();
  if (!appt) return { ok: false, error: "Appointment not found." };

  const [{ data: lead }, { data: quote }, { data: assigns }, { data: survey }] = await Promise.all([
    appt.lead_id
      ? admin
          .from("leads")
          .select("name, phone, from_address, from_postcode, to_address, to_postcode, notes")
          .eq("id", appt.lead_id)
          .single()
      : Promise.resolve({ data: null }),
    appt.lead_id
      ? admin
          .from("quotes")
          .select("quote_ref, moving_date, state_blob, accepted_at")
          .eq("lead_id", appt.lead_id)
          .eq("status", "accepted")
          .order("accepted_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("appointment_assignments").select("staff_id, vehicle_id").eq("appointment_id", appointmentId),
    appt.lead_id
      ? admin
          .from("surveys")
          .select("id")
          .eq("lead_id", appt.lead_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const staffIds = (assigns ?? []).map((a) => a.staff_id).filter(Boolean) as string[];
  const vehicleIds = (assigns ?? []).map((a) => a.vehicle_id).filter(Boolean) as string[];
  const [{ data: staffRows }, { data: vehicleRows }, photos] = await Promise.all([
    staffIds.length
      ? admin.from("staff").select("id, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    vehicleIds.length
      ? admin.from("vehicles").select("id, name, registration").in("id", vehicleIds)
      : Promise.resolve({ data: [] as { id: string; name: string; registration: string }[] }),
    survey ? loadPhotos(admin, survey.id) : Promise.resolve([] as JobSheetPhoto[]),
  ]);

  const crew = (staffRows ?? []).map((s) => s.full_name).sort();
  const vehicles = (vehicleRows ?? [])
    .map((v) => (v.registration ? `${v.name} (${v.registration})` : v.name))
    .sort();

  const data = assembleJobSheetData(
    appt,
    (lead ?? null) as SheetLead | null,
    (quote ?? null) as SheetQuote | null,
    crew,
    vehicles,
  );
  data.photos = photos;
  return { ok: true, data };
}

const CATEGORY_LABEL: Record<string, string> = { access: "Access", large_items: "Large items / extra packing" };

/** Survey photos as data URIs for pdfmake — capped, oversized files skipped. */
async function loadPhotos(
  admin: ReturnType<typeof createAdminClient>,
  surveyId: string,
): Promise<JobSheetPhoto[]> {
  const { data: rows } = await admin
    .from("survey_photos")
    .select("category, storage_path, caption")
    .eq("survey_id", surveyId)
    .order("created_at", { ascending: true })
    .limit(MAX_PHOTOS * 2);

  const out: JobSheetPhoto[] = [];
  for (const row of rows ?? []) {
    if (out.length >= MAX_PHOTOS) break;
    try {
      const { data: file } = await admin.storage.from("survey-photos").download(row.storage_path);
      if (!file) continue;
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_PHOTO_BYTES) continue;
      const mime = row.storage_path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      out.push({
        dataUri: `data:${mime};base64,${buf.toString("base64")}`,
        label: CATEGORY_LABEL[row.category] ?? row.category,
        caption: (row.caption as string | null) ?? "",
      });
    } catch {
      // A missing/corrupt object never blocks the sheet — the photo just drops.
    }
  }
  return out;
}
