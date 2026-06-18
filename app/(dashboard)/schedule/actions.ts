"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

async function ctx() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return { sb, userId: user?.id ?? null };
}

function revalidateSchedule() {
  revalidatePath("/schedule/surveys");
  revalidatePath("/schedule/removals");
  revalidatePath("/schedule/overlap");
}

export interface CreateAppointmentInput {
  apptType: "survey" | "removal";
  leadId?: string | null;
  startsAt: string; // ISO
  endsAt: string; // ISO
  title?: string;
  location?: string;
  notes?: string;
  allDay?: boolean;
}

export async function createAppointment(input: CreateAppointmentInput) {
  const { sb, userId } = await ctx();

  // Pull the lead (for client_id + status + a default title).
  let lead: { id: string; client_id: string | null; status: string; name: string | null } | null = null;
  if (input.leadId) {
    const { data } = await sb.from("leads").select("id, client_id, status, name").eq("id", input.leadId).single();
    lead = data;
  }

  // For a survey, create the linked survey record so capture has somewhere to land.
  let surveyId: string | null = null;
  if (input.apptType === "survey" && lead) {
    const { data: survey } = await sb
      .from("surveys")
      .insert({ lead_id: lead.id, client_id: lead.client_id, estimator_id: userId, status: "scheduled" })
      .select("id")
      .single();
    surveyId = survey?.id ?? null;
  }

  const { data: appt, error } = await sb
    .from("appointments")
    .insert({
      appt_type: input.apptType,
      lead_id: input.leadId ?? null,
      client_id: lead?.client_id ?? null,
      survey_id: surveyId,
      estimator_id: userId,
      title: input.title || (lead?.name ? `${input.apptType === "survey" ? "Survey" : "Removal"} — ${lead.name}` : input.apptType === "survey" ? "Survey" : "Removal"),
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      all_day: input.allDay ?? false,
      location: input.location || null,
      notes: input.notes || null,
      status: "scheduled",
    })
    .select("id")
    .single();

  if (error) return { ok: false as const, error: error.message };

  // Booking a survey nudges the lead to survey_booked (never regresses a later status).
  if (input.apptType === "survey" && lead && lead.status === "website_enquiry") {
    await sb.from("leads").update({ status: "survey_booked" as never }).eq("id", lead.id);
    await sb.from("activities").insert({
      lead_id: lead.id,
      client_id: lead.client_id,
      actor_id: userId,
      type: "survey_booked",
      summary: "Survey booked",
      meta: { appointment_id: appt.id, starts_at: input.startsAt },
    });
    revalidatePath(`/leads/${lead.id}`);
    revalidatePath("/leads");
  }

  revalidateSchedule();
  return { ok: true as const, id: appt.id };
}

export async function rescheduleAppointment(id: string, startsAt: string, endsAt: string) {
  const { sb } = await ctx();
  const { error } = await sb.from("appointments").update({ starts_at: startsAt, ends_at: endsAt }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidateSchedule();
  return { ok: true as const };
}

export async function updateAppointment(
  id: string,
  patch: { title?: string; location?: string; notes?: string; status?: string },
) {
  const { sb } = await ctx();
  const { error } = await sb
    .from("appointments")
    .update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.location !== undefined ? { location: patch.location || null } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
      ...(patch.status !== undefined ? { status: patch.status as never } : {}),
    })
    .eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidateSchedule();
  return { ok: true as const };
}

export async function deleteAppointment(id: string) {
  const { sb } = await ctx();
  const { error } = await sb.from("appointments").delete().eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidateSchedule();
  return { ok: true as const };
}
