/**
 * Night-before crew job-sheet assembly. For a given UK work-date, produce one
 * "day sheet" per assigned crew member — every job they're on that day, each
 * with the full price-free brief (addresses, access, inventory, crew mates,
 * vehicle, notes). Reuses assembleJobSheetData so the emailed PDF, the SMS web
 * view and the in-app single-job sheet can never disagree.
 *
 * Runs on the ADMIN client (crew are RLS-blocked from quotes). Batches every
 * lookup across the whole day rather than per-appointment, so it stays cheap
 * even when the cron runs every few minutes.
 */

import { apptDays, apptWindow, type ApptLite } from "@/lib/job-board";
import { assembleJobSheetData, type SheetLead, type SheetQuote } from "@/lib/job-sheet-data";
import type { JobSheetData } from "@/lib/job-sheet-docdef";
import { createHash } from "node:crypto";

type Admin = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export interface CrewMember {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}

export interface DailyJob {
  appointmentId: string;
  /** "removal" | "survey" | … — drives the Move/Survey label. */
  apptType: string;
  window: string;
  /** Sort key: appointment start (ISO) so a day's jobs read top-to-bottom. */
  startsAt: string | null;
  sheet: JobSheetData;
}

export interface CrewDaySheet {
  crew: CrewMember;
  workDate: string; // yyyy-mm-dd (UK)
  jobs: DailyJob[];
}

const startOfUkDayIso = (workDate: string): string => `${workDate}T00:00:00Z`;

/** A stable content hash of one crew member's day — the change-detection key.
 *  Any field a crew member would act on (time, address, access, inventory,
 *  crew mates, vehicle, notes, which jobs) changes the hash; cosmetic ordering
 *  does not (jobs are pre-sorted, keys serialised in a fixed order). */
export function daySheetHash(day: CrewDaySheet): string {
  const shape = day.jobs.map((j) => ({
    a: j.appointmentId,
    t: j.apptType,
    w: j.window,
    n: j.sheet.customerName,
    p: j.sheet.customerPhone,
    fr: j.sheet.from,
    to: j.sheet.to,
    veh: j.sheet.vehicles,
    vl: j.sheet.vehicleLabel,
    crew: j.sheet.crew,
    items: j.sheet.items,
    pack: j.sheet.packingLabel,
    acc: j.sheet.accessNotes,
    lg: j.sheet.largeItemsNotes,
    jn: j.sheet.jobNotes,
    d: j.sheet.moveDate,
    days: j.sheet.days,
  }));
  return createHash("sha256").update(JSON.stringify({ date: day.workDate, jobs: shape })).digest("hex");
}

/**
 * Assemble every crew member's day sheet for `workDate`. Returns them keyed by
 * staff id. Only active crew with at least one assignment that day appear.
 */
export async function assembleDaySheets(admin: Admin, workDate: string): Promise<CrewDaySheet[]> {
  const dayStart = startOfUkDayIso(workDate);
  const nextDay = new Date(new Date(dayStart).getTime() + 86_400_000).toISOString();

  // Appointments that TOUCH the work-date. A multi-day move starts earlier and
  // still spans today, so widen the lower bound by a week and confirm with
  // apptDays (the authoritative UK-day span). status != cancelled.
  const weekBefore = new Date(new Date(dayStart).getTime() - 7 * 86_400_000).toISOString();
  const { data: apptRows } = await admin
    .from("appointments")
    .select("id, title, starts_at, ends_at, all_day, appt_type, lead_id, status")
    .neq("status", "cancelled")
    .gte("starts_at", weekBefore)
    .lt("starts_at", nextDay);

  const appts = (apptRows ?? []).filter((a: any) => a.starts_at && apptDays(a as ApptLite).includes(workDate)); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!appts.length) return [];
  const apptIds = appts.map((a: any) => a.id); // eslint-disable-line @typescript-eslint/no-explicit-any

  const { data: assigns } = await admin
    .from("appointment_assignments")
    .select("appointment_id, staff_id, vehicle_id")
    .in("appointment_id", apptIds);
  const allAssigns = (assigns ?? []) as { appointment_id: string; staff_id: string | null; vehicle_id: string | null }[];

  const leadIds = [...new Set(appts.map((a: any) => a.lead_id).filter(Boolean))] as string[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const staffIds = [...new Set(allAssigns.map((a) => a.staff_id).filter(Boolean))] as string[];
  const vehicleIds = [...new Set(allAssigns.map((a) => a.vehicle_id).filter(Boolean))] as string[];

  const [{ data: leads }, { data: quotes }, { data: staff }, { data: vehicles }] = await Promise.all([
    leadIds.length
      ? admin.from("leads").select("id, name, phone, from_address, from_postcode, to_address, to_postcode, notes").in("id", leadIds)
      : Promise.resolve({ data: [] }),
    leadIds.length
      ? admin
          .from("quotes")
          .select("id, lead_id, quote_ref, moving_date, state_blob, status, accepted_at")
          .in("lead_id", leadIds)
          .eq("status", "accepted")
      : Promise.resolve({ data: [] }),
    staffIds.length
      ? admin.from("staff").select("id, full_name, email, phone, is_active").in("id", staffIds)
      : Promise.resolve({ data: [] }),
    vehicleIds.length
      ? admin.from("vehicles").select("id, name, registration").in("id", vehicleIds)
      : Promise.resolve({ data: [] }),
  ]);

  const leadById = new Map(((leads ?? []) as any[]).map((l: any) => [l.id, l])); // eslint-disable-line @typescript-eslint/no-explicit-any
  // Newest accepted quote per lead (a re-quote supersedes the earlier one).
  const quoteByLead = new Map<string, SheetQuote>();
  for (const q of (quotes ?? []) as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const prev = quoteByLead.get(q.lead_id) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!prev || String(q.accepted_at ?? "") > String(prev.accepted_at ?? "")) quoteByLead.set(q.lead_id, q);
  }
  const staffById = new Map(((staff ?? []) as any[]).map((s: any) => [s.id, s])); // eslint-disable-line @typescript-eslint/no-explicit-any
  const vehicleById = new Map(((vehicles ?? []) as any[]).map((v: any) => [v.id, v])); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Assignments grouped by appointment (for the crew/vehicle lists on each job).
  const assignsByAppt = new Map<string, typeof allAssigns>();
  for (const a of allAssigns) {
    const arr = assignsByAppt.get(a.appointment_id) ?? [];
    arr.push(a);
    assignsByAppt.set(a.appointment_id, arr);
  }

  // Build the JobSheetData once per appointment, then fan it out to each crew
  // member on that appointment.
  const jobByAppt = new Map<string, DailyJob>();
  for (const appt of appts as any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const apptAssigns = assignsByAppt.get(appt.id) ?? [];
    const crewNames = apptAssigns
      .map((a) => (a.staff_id ? staffById.get(a.staff_id)?.full_name : null))
      .filter(Boolean)
      .sort() as string[];
    const vehicleNames = apptAssigns
      .map((a) => (a.vehicle_id ? vehicleById.get(a.vehicle_id) : null))
      .filter(Boolean)
      .map((v: any) => (v.registration ? `${v.name} (${v.registration})` : v.name)) // eslint-disable-line @typescript-eslint/no-explicit-any
      .sort() as string[];

    const lead = (appt.lead_id ? leadById.get(appt.lead_id) : null) as SheetLead | null;
    const quote = (appt.lead_id ? quoteByLead.get(appt.lead_id) : null) ?? null;
    const sheet = assembleJobSheetData(appt, lead, quote as SheetQuote | null, crewNames, vehicleNames);

    jobByAppt.set(appt.id, {
      appointmentId: appt.id,
      apptType: appt.appt_type,
      window: apptWindow(appt as ApptLite),
      startsAt: appt.starts_at,
      sheet,
    });
  }

  // Group jobs under each active crew member.
  const byStaff = new Map<string, CrewDaySheet>();
  for (const a of allAssigns) {
    if (!a.staff_id) continue;
    const s = staffById.get(a.staff_id);
    if (!s || !s.is_active) continue;
    const job = jobByAppt.get(a.appointment_id);
    if (!job) continue;
    let entry = byStaff.get(a.staff_id);
    if (!entry) {
      entry = {
        crew: { id: s.id, fullName: s.full_name, email: s.email ?? null, phone: s.phone ?? null },
        workDate,
        jobs: [],
      };
      byStaff.set(a.staff_id, entry);
    }
    // A crew member can only be listed once per appointment.
    if (!entry.jobs.some((j) => j.appointmentId === job.appointmentId)) entry.jobs.push(job);
  }

  // Deterministic ordering: jobs by start time, sheets by crew name.
  const out = [...byStaff.values()];
  for (const day of out) {
    day.jobs.sort((x, y) => String(x.startsAt ?? "").localeCompare(String(y.startsAt ?? "")));
  }
  out.sort((x, y) => x.crew.fullName.localeCompare(y.crew.fullName));
  return out;
}
