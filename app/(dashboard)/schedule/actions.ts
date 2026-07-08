"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { sendCommunication } from "@/app/(dashboard)/comms-actions";
import {
  surveyConfirmEmailHtml,
  surveyConfirmEmailText,
  surveyConfirmSms,
  surveyConfirmSubject,
} from "@/lib/comms/survey-email";
import { UK_TZ } from "@/lib/uk-time";

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
}

export interface CreateAppointmentInput {
  apptType: "survey" | "removal";
  leadId?: string | null;
  estimatorId?: string | null;
  startsAt: string; // ISO
  endsAt: string; // ISO
  title?: string;
  location?: string;
  notes?: string;
  allDay?: boolean;
}

export type ConfirmSendState = "sent" | "failed" | "skipped";

export async function createAppointment(input: CreateAppointmentInput) {
  const { sb, userId } = await ctx();
  // Who actually does this visit — chosen in the dialog, defaults to the creator.
  // This is what attributes visits to Connor vs Luke for pay + win stats.
  const estimatorId = input.estimatorId ?? userId;

  // Pull the lead (for client_id + status + a default title + the confirmation send).
  let lead: {
    id: string;
    client_id: string | null;
    status: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    from_address: string | null;
    from_postcode: string | null;
  } | null = null;
  if (input.leadId) {
    const { data } = await sb
      .from("leads")
      .select("id, client_id, status, name, phone, email, from_address, from_postcode")
      .eq("id", input.leadId)
      .single();
    lead = data;
  }

  // For a survey, create the linked survey record so capture has somewhere to land.
  let surveyId: string | null = null;
  if (input.apptType === "survey" && lead) {
    const { data: survey } = await sb
      .from("surveys")
      .insert({ lead_id: lead.id, client_id: lead.client_id, estimator_id: estimatorId, status: "scheduled" })
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
      estimator_id: estimatorId,
      title: input.title || (lead?.name ? `${input.apptType === "survey" ? "Survey" : "Removal"} — ${lead.name}` : input.apptType === "survey" ? "Survey" : "Removal"),
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      all_day: input.allDay ?? false,
      // The visit happens where the move starts — derived from the lead, not typed in.
      location: input.location || (lead ? [lead.from_address, lead.from_postcode].filter(Boolean).join(", ") || null : null),
      notes: input.notes || null,
      status: "scheduled",
    })
    .select("id")
    .single();

  if (error) return { ok: false as const, error: error.message };

  // Booking a survey nudges the lead to survey_booked (never regresses a later status)
  // and counts as contact — you can't book a visit without having spoken to them.
  if (input.apptType === "survey" && lead) {
    await sb
      .from("leads")
      .update({ first_contacted_at: new Date().toISOString() })
      .eq("id", lead.id)
      .is("first_contacted_at", null);
    if (lead.status === "website_enquiry") {
      await sb.from("leads").update({ status: "survey_booked" as never }).eq("id", lead.id);
      await sb.from("activities").insert({
        lead_id: lead.id,
        client_id: lead.client_id,
        actor_id: userId,
        type: "survey_booked",
        summary: "Survey booked",
        meta: { appointment_id: appt.id, starts_at: input.startsAt },
      });
    }
    revalidatePath(`/leads/${lead.id}`);
    revalidatePath("/leads");
  }

  // Customer confirmation (survey only): SMS + branded email, fail-soft — a comms
  // hiccup never unbooks the survey. Both go through sendCommunication so they are
  // duplicate-guarded and land on the lead's Comms tab.
  const comms: { email: ConfirmSendState; sms: ConfirmSendState } = { email: "skipped", sms: "skipped" };
  if (input.apptType === "survey" && lead) {
    const starts = new Date(input.startsAt);
    const confirm = {
      customerName: lead.name,
      dateLabel: starts.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: UK_TZ }),
      timeLabel: starts.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: UK_TZ }),
      estimatorName: estimatorId
        ? (await sb.from("profiles").select("full_name").eq("id", estimatorId).single()).data?.full_name ?? null
        : null,
      address: input.location || lead.from_address || lead.from_postcode || null,
    };
    if (lead.email) {
      // When the Resend template is published (env holds its alias/id), send via the
      // template so the design is editable in the Resend dashboard without a deploy.
      // Otherwise fall back to the in-repo HTML.
      const templateId = process.env.RESEND_TEMPLATE_SURVEY_CONFIRMATION;
      const r = await sendCommunication({
        channel: "email",
        to: lead.email,
        subject: surveyConfirmSubject(confirm),
        bodyText: surveyConfirmEmailText(confirm),
        ...(templateId
          ? {
              template: {
                id: templateId,
                variables: {
                  FIRST_NAME: (lead.name || "").trim().split(/\s+/)[0] || "there",
                  DATE_LABEL: confirm.dateLabel,
                  TIME_LABEL: confirm.timeLabel,
                  ESTIMATOR: confirm.estimatorName ?? "One of our team",
                  ADDRESS: confirm.address ?? "To be confirmed",
                },
              },
            }
          : { bodyHtml: surveyConfirmEmailHtml(confirm) }),
        leadId: lead.id,
        clientId: lead.client_id ?? undefined,
      }).catch(() => ({ ok: false as const, error: "send crashed" }));
      comms.email = "ok" in r && r.ok ? "sent" : "duplicate" in r ? "sent" : "failed";
    }
    if (lead.phone) {
      const r = await sendCommunication({
        channel: "sms",
        to: lead.phone,
        bodyText: surveyConfirmSms(confirm),
        leadId: lead.id,
        clientId: lead.client_id ?? undefined,
      }).catch(() => ({ ok: false as const, error: "send crashed" }));
      comms.sms = "ok" in r && r.ok ? "sent" : "duplicate" in r ? "sent" : "failed";
    }
  }

  revalidateSchedule();
  return { ok: true as const, id: appt.id, comms };
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
  patch: { title?: string; location?: string; notes?: string; status?: string; estimatorId?: string | null },
) {
  const { sb } = await ctx();
  const { error } = await sb
    .from("appointments")
    .update({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.location !== undefined ? { location: patch.location || null } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes || null } : {}),
      ...(patch.status !== undefined ? { status: patch.status as never } : {}),
      ...(patch.estimatorId !== undefined ? { estimator_id: patch.estimatorId } : {}),
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
