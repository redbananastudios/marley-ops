/**
 * Job-sheet loading — shared by the PDF action (app/actions/job-sheet.ts) and
 * the /my-jobs/[id] web view, so the sheet on paper and the sheet on screen
 * can never drift. Runs on the ADMIN client: crew are RLS-blocked from the
 * quotes table (pricing lockdown) but the sheet needs the quote's inventory +
 * addresses. assembleJobSheetData never emits money (test-enforced), so
 * nothing price-shaped leaves here. Callers MUST auth-check first.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { assembleJobSheetData, type SheetLead, type SheetQuote } from "@/lib/job-sheet-data";
import type { JobSheetData, JobSheetPhoto } from "@/lib/job-sheet-docdef";

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 1_500_000;

const CATEGORY_LABEL: Record<string, string> = { access: "Access", large_items: "Large items / extra packing" };

type Admin = ReturnType<typeof createAdminClient>;

export interface JobSheetLoad {
  data: JobSheetData;
  apptType: string;
  surveyId: string | null;
  quoteId: string | null;
  leadId: string | null;
}

/** Assemble the price-free sheet for one appointment (photos NOT included —
 *  pick loadPhotoDataUris (PDF) or loadPhotoSignedUrls (web) per surface). */
export async function loadJobSheet(admin: Admin, appointmentId: string): Promise<JobSheetLoad | null> {
  const { data: appt } = await admin
    .from("appointments")
    .select("id, title, starts_at, ends_at, all_day, appt_type, lead_id")
    .eq("id", appointmentId)
    .single();
  if (!appt) return null;

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
          .select("id, quote_ref, moving_date, state_blob, accepted_at")
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
  const [{ data: staffRows }, { data: vehicleRows }] = await Promise.all([
    staffIds.length
      ? admin.from("staff").select("id, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    vehicleIds.length
      ? admin.from("vehicles").select("id, name, registration").in("id", vehicleIds)
      : Promise.resolve({ data: [] as { id: string; name: string; registration: string }[] }),
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

  // Contract flag: accepted quote with no signature row = collect on arrival.
  const quoteId = (quote as { id?: string } | null)?.id ?? null;
  if (quoteId) {
    const { data: sig } = await admin
      .from("signatures")
      .select("id")
      .eq("quote_id", quoteId)
      .eq("kind", "contract")
      .limit(1)
      .maybeSingle();
    data.contractSigned = !!sig;
  } else {
    data.contractSigned = null;
  }

  return { data, apptType: appt.appt_type, surveyId: survey?.id ?? null, quoteId, leadId: appt.lead_id ?? null };
}

/** Survey photos as data URIs for pdfmake — capped, oversized files skipped. */
export async function loadPhotoDataUris(admin: Admin, surveyId: string): Promise<JobSheetPhoto[]> {
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

export interface WebPhoto {
  url: string;
  label: string;
  caption: string;
}

/** Survey photos as short-lived signed URLs for the /my-jobs/[id] web view —
 *  lighter than data URIs on a phone in a van. */
export async function loadPhotoSignedUrls(admin: Admin, surveyId: string): Promise<WebPhoto[]> {
  const { data: rows } = await admin
    .from("survey_photos")
    .select("category, storage_path, caption")
    .eq("survey_id", surveyId)
    .order("created_at", { ascending: true })
    .limit(12);
  if (!rows?.length) return [];

  const { data: signed } = await admin.storage
    .from("survey-photos")
    .createSignedUrls(rows.map((r) => r.storage_path), 3600);
  const urlByPath = new Map((signed ?? []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]));

  return rows
    .map((r) => {
      const url = urlByPath.get(r.storage_path);
      return url
        ? { url, label: CATEGORY_LABEL[r.category] ?? r.category, caption: (r.caption as string | null) ?? "" }
        : null;
    })
    .filter(Boolean) as WebPhoto[];
}
