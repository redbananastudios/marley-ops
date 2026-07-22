"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ensureLeadForClient } from "@/lib/leads/for-client";
import { balanceDueDate } from "@/lib/quote/payments";
import { commitmentDueDate } from "@/lib/payments-policy";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { ukInstant } from "@/lib/uk-time";
import { sendCommunication } from "@/app/(dashboard)/comms-actions";
import { ownerFrom } from "@/lib/comms/sender";
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
  /** A bare client picked in the diary (no enquiry yet) — we open one first. */
  clientId?: string | null;
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

  // Booked against a bare client: open (or reuse) their enquiry first — every
  // booking hangs off a lead so the funnel/chase/quote layers all work.
  if (!input.leadId && input.clientId) {
    const ensured = await ensureLeadForClient(sb, input.clientId, userId, "manual");
    if (!ensured.ok) return { ok: false as const, error: ensured.error };
    input = { ...input, leadId: ensured.leadId };
  }

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
    const estimator = estimatorId
      ? (await sb.from("profiles").select("full_name, email, active").eq("id", estimatorId).maybeSingle()).data
      : null;
    const confirm = {
      customerName: lead.name,
      dateLabel: starts.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: UK_TZ }),
      timeLabel: starts.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: UK_TZ }),
      estimatorName: estimator?.full_name ?? null,
      address: input.location || lead.from_address || lead.from_postcode || null,
    };
    if (lead.email) {
      // When the Resend template is published (env holds its alias/id), send via the
      // template so the design is editable in the Resend dashboard without a deploy.
      // Otherwise fall back to the in-repo HTML.
      const templateId = process.env.RESEND_TEMPLATE_SURVEY_CONFIRMATION;
      const r = await sendCommunication({
        channel: "email",
        // From the SURVEYING estimator (who the customer will actually meet) —
        // at booking time the lead often has no explicit owner yet, so the
        // generic owner injection would miss.
        from: estimator?.active ? ownerFrom(estimator.full_name, estimator.email) : undefined,
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
  const { sb, userId } = await ctx();
  // Capture the old slot BEFORE the update so a day-change can re-arm reminders.
  const { data: before } = await sb.from("appointments").select("starts_at").eq("id", id).maybeSingle();
  const { error } = await sb.from("appointments").update({ starts_at: startsAt, ends_at: endsAt }).eq("id", id);
  if (error) return { ok: false as const, error: error.message };

  // Day changed → the night-before crew reminder must fire again for the new
  // date (audit 2026-07-10: reminded_at stayed set, so rescheduled jobs never
  // re-notified the crew).
  const oldDay = before?.starts_at
    ? new Date(before.starts_at).toLocaleDateString("en-CA", { timeZone: UK_TZ })
    : null;
  const newDay = new Date(startsAt).toLocaleDateString("en-CA", { timeZone: UK_TZ });
  if (oldDay && oldDay !== newDay) {
    await sb.from("appointment_assignments").update({ reminded_at: null } as never).eq("appointment_id", id);
  }

  // Moving a REMOVAL moves the money dates with it: the accepted quote's move
  // date, the lead's balance-due date, and the open balance chase — otherwise
  // the "day before move" reminder stays pinned to the old date.
  const { data: appt } = await sb
    .from("appointments")
    .select("appt_type, lead_id")
    .eq("id", id)
    .maybeSingle();
  if (appt?.appt_type === "removal" && appt.lead_id) {
    // yyyy-mm-dd of the new slot as a UK wall-clock day (en-CA = ISO format).
    const newMoveDate = new Date(startsAt).toLocaleDateString("en-CA", { timeZone: UK_TZ });
    const { data: accepted } = await sb
      .from("quotes")
      .select(
        "id, moving_date, quote_ref, commitment_paid_at, commitment_due_date, zoho_commitment_invoice_id, zoho_commitment_invoice_number",
      )
      .eq("lead_id", appt.lead_id)
      .eq("status", "accepted")
      .order("accepted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (accepted && accepted.moving_date !== newMoveDate) {
      await sb.from("quotes").update({ moving_date: newMoveDate } as never).eq("id", accepted.id);

      // The commitment ladder's one-shot stamps are per MOVE DATE: a new date
      // re-arms the T-10 chase and drops the stale T-7 "Dates at risk" flag —
      // the cron re-stamps both at the new date's thresholds. Paid
      // commitments are history and never touched.
      if (!accepted.commitment_paid_at) {
        await sb
          .from("quotes")
          .update({ commitment_chase_t10_at: null, date_releasable_at: null } as never)
          .eq("id", accepted.id)
          .is("commitment_paid_at", null);
      }
      const dueDate = balanceDueDate(newMoveDate);
      await sb.from("leads").update({ balance_due_date: dueDate } as never).eq("id", appt.lead_id);
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
      if (dm) {
        const dueAt = ukInstant(Number(dm[1]), Number(dm[2]), Number(dm[3]), 9, 0).toISOString();
        await sb
          .from("follow_ups")
          .update({ due_at: dueAt })
          .eq("lead_id", appt.lead_id)
          .eq("reason", "balance")
          .eq("status", "open");
      }

      // Payments Policy v2: the commitment falls due move−7d (clamped to
      // today), so an UNPAID commitment's due date rolls with the move. A paid
      // commitment is history and never recomputes. Money-state change → the
      // events_log audit row rides beside the timeline activity below; the
      // Zoho -COM invoice (when one exists) has no update API, so the money
      // desk gets a manual-adjustment alert. All fail-soft.
      const hasCommitmentLadder =
        !accepted.commitment_paid_at &&
        (accepted.commitment_due_date ||
          (accepted.zoho_commitment_invoice_id && accepted.zoho_commitment_invoice_id !== "pending"));
      if (hasCommitmentLadder) {
        const newDue = commitmentDueDate(newMoveDate);
        if (newDue !== accepted.commitment_due_date) {
          const { error: dueError } = await sb
            .from("quotes")
            .update({ commitment_due_date: newDue } as never)
            .eq("id", accepted.id)
            .is("commitment_paid_at", null);
          if (dueError) {
            await sendOpsAlert(`Commitment due-date recompute FAILED — ${accepted.quote_ref}`, [
              `The move was rescheduled to ${newMoveDate} but updating the commitment due date failed: ${dueError.message}. Set it by hand.`,
            ], "system");
          } else {
            await sb.from("events_log").insert({
              actor_id: userId,
              entity_type: "quote",
              entity_id: accepted.id,
              action: "commitment_due_date_recomputed",
              diff: { moving_date: newMoveDate, from: accepted.commitment_due_date, to: newDue } as never,
            });
            if (accepted.zoho_commitment_invoice_id && accepted.zoho_commitment_invoice_id !== "pending") {
              await sendOpsAlert(`Adjust commitment invoice due date — ${accepted.quote_ref}`, [
                `The move date changed to ${newMoveDate}, so commitment invoice ${accepted.zoho_commitment_invoice_number ?? `${accepted.quote_ref}-COM`} is now due ${newDue}.`,
                `Zoho invoice due dates can't be updated from the panel — adjust it manually in Zoho.`,
              ], "money");
            }
          }
        }
      }
      await sb.from("activities").insert({
        lead_id: appt.lead_id,
        actor_id: userId,
        type: "note",
        summary: `Removal rescheduled — move date now ${newMoveDate}; balance chase follows it`,
        meta: { appointment_id: id, moving_date: newMoveDate },
      });
      revalidatePath("/bookings");
      revalidatePath(`/leads/${appt.lead_id}`);
    }
  }

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

  // Survey done → the next step is the quote. If the lead has no quote yet,
  // queue a "build the quote" follow-up so completed surveys can't go cold.
  if (patch.status === "completed") {
    const { data: appt } = await sb
      .from("appointments")
      .select("appt_type, lead_id, client_id, estimator_id")
      .eq("id", id)
      .maybeSingle();
    if (appt?.appt_type === "survey" && appt.lead_id) {
      const [{ data: existingQuote }, { data: openFu }] = await Promise.all([
        sb.from("quotes").select("id").eq("lead_id", appt.lead_id).limit(1).maybeSingle(),
        sb
          .from("follow_ups")
          .select("id")
          .eq("lead_id", appt.lead_id)
          .eq("reason", "quote_followup")
          .eq("status", "open")
          .limit(1)
          .maybeSingle(),
      ]);
      if (!existingQuote && !openFu) {
        const { data: { user } } = await sb.auth.getUser();
        await sb.from("follow_ups").insert({
          lead_id: appt.lead_id,
          client_id: appt.client_id,
          reason: "quote_followup",
          due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          assigned_to: appt.estimator_id,
          created_by: user?.id ?? null,
          source: "survey_completed",
          notes: "Survey completed — build and send the quote.",
        } as never);
        revalidatePath("/follow-ups");
      }
    }
  }

  revalidateSchedule();
  return { ok: true as const };
}

export async function deleteAppointment(id: string) {
  const { sb } = await ctx();
  const { error } = await sb.from("appointments").delete().eq("id", id);
  if (error) {
    // FK RESTRICT (migration 0026): a signed-off job's completion record must
    // outlive the diary row — deleting the appointment would destroy evidence.
    if (error.code === "23503") {
      return {
        ok: false as const,
        error: "This job has a signed completion record — it can't be deleted. Cancel it instead.",
      };
    }
    return { ok: false as const, error: error.message };
  }
  revalidateSchedule();
  return { ok: true as const };
}
