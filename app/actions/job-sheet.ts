"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { assembleJobSheetData, type SheetLead, type SheetQuote } from "@/lib/job-sheet-data";
import type { JobSheetData } from "@/lib/job-sheet-docdef";

/** Everything the client-side pdfmake needs for one job's crew sheet.
 *  Available to every active login — crew included (they print their own). */
export async function getJobSheetDataAction(
  appointmentId: string,
): Promise<{ ok: true; data: JobSheetData } | { ok: false; error: string }> {
  if (!z.string().uuid().safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: appt } = await sb
    .from("appointments")
    .select("id, title, starts_at, ends_at, all_day, appt_type, lead_id")
    .eq("id", appointmentId)
    .single();
  if (!appt) return { ok: false, error: "Appointment not found." };

  const [{ data: lead }, { data: quote }, { data: assigns }] = await Promise.all([
    appt.lead_id
      ? sb
          .from("leads")
          .select("name, phone, from_address, from_postcode, to_address, to_postcode, notes")
          .eq("id", appt.lead_id)
          .single()
      : Promise.resolve({ data: null }),
    appt.lead_id
      ? sb
          .from("quotes")
          .select("quote_ref, moving_date, state_blob, accepted_at")
          .eq("lead_id", appt.lead_id)
          .eq("status", "accepted")
          .order("accepted_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("appointment_assignments").select("staff_id, vehicle_id").eq("appointment_id", appointmentId),
  ]);

  const staffIds = (assigns ?? []).map((a) => a.staff_id).filter(Boolean) as string[];
  const vehicleIds = (assigns ?? []).map((a) => a.vehicle_id).filter(Boolean) as string[];
  const [{ data: staffRows }, { data: vehicleRows }] = await Promise.all([
    staffIds.length
      ? sb.from("staff").select("id, full_name").in("id", staffIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    vehicleIds.length
      ? sb.from("vehicles").select("id, name, registration").in("id", vehicleIds)
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
  return { ok: true, data };
}
