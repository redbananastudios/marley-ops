/**
 * Job-sheet loading — shared by the PDF action (app/actions/job-sheet.ts) and
 * the /my-jobs/[id] web view, so the sheet on paper and the sheet on screen
 * can never drift. Runs on the ADMIN client: crew are RLS-blocked from the
 * quotes table (pricing lockdown) but the sheet needs the quote's inventory +
 * addresses. assembleJobSheetData never emits money (test-enforced), so
 * nothing price-shaped leaves here. Callers MUST auth-check first.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { createMediaStore } from "@/lib/storage/media-store";
import { SURVEY_PHOTOS_BUCKET } from "@/lib/survey-photos";
import { assembleJobSheetData, type SheetLead, type SheetQuote } from "@/lib/job-sheet-data";
import {
  computeCubicTotals,
  groupCubicLinesByRoom,
  recommendVans,
  sanitizeCubicLines,
  vehicleShortLabel,
} from "@/lib/cubic-survey";
import { getBusinessSettings } from "@/lib/settings";
import type { JobSheetData, JobSheetPhoto } from "@/lib/job-sheet-docdef";

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 1_500_000;

const CATEGORY_LABEL: Record<string, string> = {
  access: "Access",
  large_items: "Large items / extra packing",
  cubic: "Volume survey",
};

const SURVEY_VIDEO_KINDS = ["room_video", "import_video"] as const;
// Crew can watch any footage that finished uploading — the walkthrough is
// useful to them regardless of whether the AI analysis is still running or
// even failed. Excluded: uploading (incomplete), ignored (estimator
// discarded), deletion_pending/deleted (retention/consent-withdrawn).
const SURVEY_VIDEO_STATUSES = ["uploaded", "processing", "processed", "failed"] as const;

type Admin = ReturnType<typeof createAdminClient>;

export interface JobSheetLoad {
  data: JobSheetData;
  apptType: string;
  surveyId: string | null;
  /** cubic_surveys.id — anchors the AI walkthrough videos (survey-media bucket). */
  cubicSurveyId: string | null;
  quoteId: string | null;
  leadId: string | null;
}

/** Is this login assigned to this appointment? Mirrors the /my-jobs listing
 *  gate (link login → staff by profile_id then email, then check
 *  appointment_assignments) so the detail page can only serve a crew member the
 *  jobs they're actually on. Office roles bypass this — they legitimately view
 *  any job. Used before minting signed survey-media URLs on the crew page. */
export async function crewAssignedToAppointment(
  admin: Admin,
  profileId: string,
  email: string | null,
  appointmentId: string,
): Promise<boolean> {
  // A cancelled job never appears in the crew's /my-jobs list — don't let a
  // stale direct URL resurrect it (review finding, 2026-07-14).
  const { data: appt } = await admin
    .from("appointments")
    .select("status")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appt || appt.status === "cancelled") return false;

  let staffId: string | null = null;
  const { data: byId } = await admin
    .from("staff")
    .select("id")
    .eq("profile_id", profileId)
    .eq("is_active", true)
    .maybeSingle();
  staffId = byId?.id ?? null;
  if (!staffId && email) {
    const { data: byEmail } = await admin
      .from("staff")
      .select("id")
      .ilike("email", email)
      .eq("is_active", true)
      .maybeSingle();
    staffId = byEmail?.id ?? null;
  }
  if (!staffId) return false;

  const { data: assign } = await admin
    .from("appointment_assignments")
    .select("appointment_id")
    .eq("appointment_id", appointmentId)
    .eq("staff_id", staffId)
    .maybeSingle();
  return !!assign;
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

  // Cubic-survey data for the crew — volume summary + the FULL room-grouped
  // item list + a count of the AI walkthrough videos. All price-free (owner
  // decision, 2026-07-14: crew see everything a survey collected except money).
  let cubicSurveyId: string | null = null;
  if (appt.lead_id) {
    const { data: cubic } = await admin
      .from("cubic_surveys")
      .select("id, items, total_ft3")
      .eq("lead_id", appt.lead_id)
      .maybeSingle();
    if (cubic) {
      cubicSurveyId = cubic.id;
      const lines = sanitizeCubicLines(cubic.items) ?? [];

      // Full room-grouped inventory (regardless of total_ft3 — a survey may
      // have videos/items before the office confirms the volume total).
      const inventory = groupCubicLinesByRoom(lines);
      if (inventory.length) data.surveyInventory = inventory;

      if (Number(cubic.total_ft3) > 0) {
        const totals = computeCubicTotals(lines);
        const settings = await getBusinessSettings(admin);
        const rec = recommendVans(Number(cubic.total_ft3), {
          fillPct: settings.cubicFillPct,
          transitFt3: settings.cubicTransitFt3,
          lutonFt3: settings.cubicLutonFt3,
          sevenFiveTFt3: settings.cubic75tFt3,
        });
        const bits = [
          `Volume survey: ${Number(cubic.total_ft3).toLocaleString("en-GB")} ft³${rec ? ` (≈ ${vehicleShortLabel(rec)})` : ""}`,
          totals.dismantleCount ? `${totals.dismantleCount} to dismantle` : null,
          totals.fragileCount ? `${totals.fragileCount} fragile/high-value` : null,
        ].filter(Boolean);
        data.volumeLine = bits.join(" · ");
      }

      // Video count gates the PDF's QR block; the web view mints signed URLs.
      const { count } = await admin
        .from("cubic_survey_media")
        .select("id", { count: "exact", head: true })
        .eq("survey_id", cubic.id)
        .in("kind", SURVEY_VIDEO_KINDS as unknown as string[])
        .in("status", SURVEY_VIDEO_STATUSES as unknown as string[])
        .not("storage_path", "is", null);
      data.videoCount = count ?? 0;
      if ((count ?? 0) > 0) {
        const base = process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk";
        data.jobUrl = `${base}/my-jobs/${appointmentId}`;
      }
    }
  }

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

  return {
    data,
    apptType: appt.appt_type,
    surveyId: survey?.id ?? null,
    cubicSurveyId,
    quoteId,
    leadId: appt.lead_id ?? null,
  };
}

/** Survey photos as data URIs for pdfmake — capped, oversized files skipped. */
export async function loadPhotoDataUris(admin: Admin, surveyId: string): Promise<JobSheetPhoto[]> {
  const { data: rows } = await admin
    .from("survey_photos")
    .select("category, storage_path, caption")
    .eq("survey_id", surveyId)
    .order("created_at", { ascending: true })
    .limit(MAX_PHOTOS * 2);

  // Route through the media-store seam so photos follow the active driver (R2
  // in prod). getObject returns raw bytes; pdfmake needs a base64 data URI.
  const store = createMediaStore(process.env, { bucket: SURVEY_PHOTOS_BUCKET });
  const out: JobSheetPhoto[] = [];
  for (const row of rows ?? []) {
    if (out.length >= MAX_PHOTOS) break;
    try {
      const bytes = await store.getObject(row.storage_path);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) continue;
      const mime = row.storage_path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      out.push({
        dataUri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
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

  // Sign through the seam (active driver — R2 in prod). One key at a time so a
  // failed sign drops that photo rather than the whole set (matches the survey
  // video loader; a direct Supabase batch sign broke under the s3 driver).
  const store = createMediaStore(process.env, { bucket: SURVEY_PHOTOS_BUCKET });
  const signed = await Promise.all(
    rows.map(async (r) => {
      try {
        return { path: r.storage_path, signedUrl: await store.createSignedGetUrl(r.storage_path, 3600) };
      } catch {
        return { path: r.storage_path, signedUrl: null as string | null };
      }
    }),
  );
  const urlByPath = new Map(signed.filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl as string]));

  return rows
    .map((r) => {
      const url = urlByPath.get(r.storage_path);
      return url
        ? { url, label: CATEGORY_LABEL[r.category] ?? r.category, caption: (r.caption as string | null) ?? "" }
        : null;
    })
    .filter(Boolean) as WebPhoto[];
}

export interface SurveyVideo {
  url: string;
  room: string | null;
  durationS: number | null;
  kind: "room_video" | "import_video";
}

/** AI survey walkthrough videos as short-lived signed URLs for the crew job
 *  page. The survey-media bucket is office-only at the RLS layer — crew reach
 *  it exclusively through this service-role loader, never by widening RLS. */
export async function loadSurveyVideoSignedUrls(admin: Admin, cubicSurveyId: string): Promise<SurveyVideo[]> {
  const { data: rows } = await admin
    .from("cubic_survey_media")
    .select("room_id, kind, storage_path, duration_s")
    .eq("survey_id", cubicSurveyId)
    .in("kind", SURVEY_VIDEO_KINDS as unknown as string[])
    .in("status", SURVEY_VIDEO_STATUSES as unknown as string[])
    .not("storage_path", "is", null)
    .order("created_at", { ascending: true });
  if (!rows?.length) return [];

  const roomIds = [...new Set(rows.map((r) => r.room_id).filter(Boolean))] as string[];
  const { data: roomRows } = roomIds.length
    ? await admin.from("cubic_survey_rooms").select("id, name").in("id", roomIds)
    : { data: [] as { id: string; name: string }[] };
  const roomName = new Map((roomRows ?? []).map((r) => [r.id, r.name]));

  // Route through the media-store seam so this follows the active storage driver
  // (R2 in prod). The seam signs one key at a time; a failed sign drops that one
  // video rather than the whole set. (Was a direct Supabase batch sign, which
  // broke under the s3 driver — objects live in R2, not Supabase.)
  const store = createMediaStore();
  const signed = await Promise.all(
    rows.map(async (r) => {
      try {
        return { path: r.storage_path, signedUrl: await store.createSignedGetUrl(r.storage_path, 3600) };
      } catch {
        return { path: r.storage_path, signedUrl: null as string | null };
      }
    }),
  );
  const urlByPath = new Map(signed.filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl as string]));

  return rows
    .map((r) => {
      const url = urlByPath.get(r.storage_path);
      if (!url) return null;
      return {
        url,
        room: r.room_id ? roomName.get(r.room_id) ?? null : null,
        durationS: r.duration_s ?? null,
        kind: r.kind as "room_video" | "import_video",
      };
    })
    .filter(Boolean) as SurveyVideo[];
}
