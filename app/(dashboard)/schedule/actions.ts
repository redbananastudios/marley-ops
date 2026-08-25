"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ensureLeadForClient } from "@/lib/leads/for-client";
import { DEFAULT_BRAND } from "@/lib/brand";
import { balanceDueDate } from "@/lib/quote/payments";
import { commitmentDueDate } from "@/lib/payments-policy";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { ukInstant } from "@/lib/uk-time";
import { sendCommunication } from "@/app/(dashboard)/comms-actions";
import { dayDelta } from "@/lib/schedule/pack-days";
import { shiftPackDays } from "@/lib/schedule/pack-days-io";
import { ownerFrom } from "@/lib/comms/sender";
import {
  surveyConfirmEmailHtml,
  surveyConfirmEmailText,
  surveyConfirmSms,
  surveyConfirmSubject,
  surveyRescheduleEmailHtml,
  surveyRescheduleEmailText,
  surveyRescheduleSms,
  surveyRescheduleSubject,
  surveyCancelledEmailHtml,
  surveyCancelledEmailText,
  surveyCancelledSms,
  surveyCancelledSubject,
} from "@/lib/comms/survey-email";
import { notifyEstimatorOfSurvey, ukSlotLabel } from "@/lib/schedule/notify-estimator";
import type { SendState, SurveySendOutcome } from "@/lib/comms/survey-send-report";
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
  /** Removal only: also put a crew-only packing day on the diary (yyyy-mm-dd,
   *  usually the day before the move). Created 09:00–16:00 UK on that day. */
  packDate?: string | null;
  /**
   * Send the customer their survey confirmation (Peter, 2026-08-08 — "on any
   * email that's going to be sent for a survey, we should confirm with the user
   * if they want to send it"). The dialog always passes this explicitly from a
   * visible tick box; it defaults to true so any other caller keeps the
   * long-standing behaviour rather than silently going quiet.
   */
  notifyCustomer?: boolean;
}

// Re-exported so existing callers keep working; the canonical union (which now
// distinguishes a duplicate-suppressed send from a real one) lives with the
// formatter the UI uses to describe it.
export type ConfirmSendState = SendState;

export type SurveyCommsResult = SurveySendOutcome;

type LeadForNotice = {
  id: string;
  client_id: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  from_address: string | null;
  from_postcode: string | null;
};

/**
 * The customer's survey confirmation — the booked version and the moved
 * version, which differ only in copy. Shared so a reschedule can never drift
 * out of step with a booking (before 2026-08-08 a reschedule sent nothing at
 * all, leaving the customer holding an email for a time we no longer intended
 * to turn up).
 *
 * Fail-soft: a comms hiccup never unbooks or unmoves the visit. Both channels
 * go through sendCommunication so they are duplicate-guarded and land on the
 * lead's Comms tab.
 */
async function sendSurveyCustomerNotice(
  sb: Awaited<ReturnType<typeof createClient>>,
  opts: {
    kind: "booked" | "moved" | "cancelled";
    lead: LeadForNotice;
    estimatorId: string | null;
    startsAt: string;
    /** Explicit visit address, else derived from the lead's pickup address. */
    location?: string | null;
    /** The slot being replaced — only used by the moved copy. */
    previousStartsAt?: string | null;
  },
): Promise<SurveyCommsResult> {
  const comms: SurveyCommsResult = { email: "skipped", sms: "skipped" };
  const { lead, kind } = opts;
  const starts = new Date(opts.startsAt);
  const estimator = opts.estimatorId
    ? (await sb.from("profiles").select("full_name, email, active").eq("id", opts.estimatorId).maybeSingle()).data
    : null;
  const confirm = {
    customerName: lead.name,
    dateLabel: starts.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: UK_TZ }),
    timeLabel: starts.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: UK_TZ }),
    estimatorName: estimator?.full_name ?? null,
    address: opts.location || lead.from_address || lead.from_postcode || null,
    previousLabel: ukSlotLabel(opts.previousStartsAt) ?? null,
  };

  const copy = {
    booked: {
      subject: surveyConfirmSubject,
      html: surveyConfirmEmailHtml,
      text: surveyConfirmEmailText,
      sms: surveyConfirmSms,
      templateId: process.env.RESEND_TEMPLATE_SURVEY_CONFIRMATION,
    },
    moved: {
      subject: surveyRescheduleSubject,
      html: surveyRescheduleEmailHtml,
      text: surveyRescheduleEmailText,
      sms: surveyRescheduleSms,
      templateId: process.env.RESEND_TEMPLATE_SURVEY_RESCHEDULED,
    },
    cancelled: {
      subject: surveyCancelledSubject,
      html: surveyCancelledEmailHtml,
      text: surveyCancelledEmailText,
      sms: surveyCancelledSms,
      templateId: process.env.RESEND_TEMPLATE_SURVEY_CANCELLED,
    },
  }[kind];

  if (lead.email) {
    // When the Resend template is published (env holds its alias/id), send via the
    // template so the design is editable in the Resend dashboard without a deploy.
    // Otherwise fall back to the in-repo HTML.
    const r = await sendCommunication({
      channel: "email",
      // From the SURVEYING estimator (who the customer will actually meet) —
      // at booking time the lead often has no explicit owner yet, so the
      // generic owner injection would miss.
      from: estimator?.active ? ownerFrom(estimator.full_name, estimator.email) : undefined,
      to: lead.email,
      subject: copy.subject(confirm),
      bodyText: copy.text(confirm),
      ...(copy.templateId
        ? {
            template: {
              id: copy.templateId,
              variables: {
                FIRST_NAME: (lead.name || "").trim().split(/\s+/)[0] || "there",
                DATE_LABEL: confirm.dateLabel,
                TIME_LABEL: confirm.timeLabel,
                ESTIMATOR: confirm.estimatorName ?? "One of our team",
                ADDRESS: confirm.address ?? "To be confirmed",
                ...(kind === "moved" ? { PREVIOUS: confirm.previousLabel ?? "an earlier time" } : {}),
              },
            },
            // Rendered fallback for the oversize guard + SMTP outage transport.
            bodyHtml: copy.html(confirm),
          }
        : { bodyHtml: copy.html(confirm) }),
      leadId: lead.id,
      clientId: lead.client_id ?? undefined,
    }).catch(() => ({ ok: false as const, error: "send crashed" }));
    comms.email = "ok" in r && r.ok ? "sent" : "duplicate" in r ? "duplicate" : "failed";
  }

  if (lead.phone) {
    const r = await sendCommunication({
      channel: "sms",
      to: lead.phone,
      bodyText: copy.sms(confirm),
      leadId: lead.id,
      clientId: lead.client_id ?? undefined,
    }).catch(() => ({ ok: false as const, error: "send crashed" }));
    comms.sms = "ok" in r && r.ok ? "sent" : "duplicate" in r ? "duplicate" : "failed";
  }

  return comms;
}

export async function createAppointment(input: CreateAppointmentInput) {
  const { sb, userId } = await ctx();
  // Who actually does this visit — chosen in the dialog, defaults to the creator
  // ONLY when the caller didn't express a view. This is what attributes visits
  // to Connor vs Luke for pay + win stats. `?? userId` used to swallow an
  // explicit "Unassigned" (the dialog sends null for it), so picking Unassigned
  // silently billed the visit to whoever clicked Book and told the customer
  // that person was coming. The edit path already honoured null.
  const estimatorId = input.estimatorId !== undefined ? input.estimatorId : userId;

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
    brand: string;
  } | null = null;
  if (input.leadId) {
    const { data } = await sb
      .from("leads")
      .select("id, client_id, status, name, phone, email, from_address, from_postcode, brand")
      .eq("id", input.leadId)
      .single();
    lead = data;
  }

  // For a survey, attach the linked survey record so capture has somewhere to
  // land. REUSE the lead's existing scheduled survey rather than inserting
  // blindly: every consumer (photo uploads, the quote builder's hydrate, the
  // lead page, the crew job sheet, the daily crew sheets) reads only the LATEST
  // surveys row for a lead, so a second row silently shadows the first — and
  // takes its access + large-item photos out of the crew's job sheet with it.
  // That happened whenever photos were uploaded before the survey was booked,
  // or a survey was cancelled and re-booked.
  let surveyId: string | null = null;
  let surveyWarning: string | null = null;
  if (input.apptType === "survey" && lead) {
    const { data: existing } = await sb
      .from("surveys")
      .select("id, status")
      .eq("lead_id", lead.id)
      .neq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // A COMPLETED survey is history: a genuine second visit gets its own row
    // rather than resetting the first one back to scheduled and overwriting
    // what was recorded on it.
    if (existing) {
      surveyId = existing.id;
      // Re-point it at whoever is actually attending this booking.
      await sb.from("surveys").update({ estimator_id: estimatorId, status: "scheduled" }).eq("id", existing.id);
    } else {
      const { data: survey, error: surveyError } = await sb
        .from("surveys")
        .insert({ lead_id: lead.id, client_id: lead.client_id, estimator_id: estimatorId, status: "scheduled" })
        .select("id")
        .single();
      surveyId = survey?.id ?? null;
      // Previously discarded: a failed insert produced an appointment with no
      // survey record and a clean "Survey booked." toast, so photos taken on
      // the visit had nowhere to attach. Surface it like the pack-day warning.
      if (surveyError) surveyWarning = surveyError.message;
    }
  }

  const { data: appt, error } = await sb
    .from("appointments")
    .insert({
      appt_type: input.apptType,
      // Denormalised from the parent lead at insert (PRD §3.2) — the diary
      // colours an appointment without a join.
      brand: lead?.brand ?? DEFAULT_BRAND,
      lead_id: input.leadId ?? null,
      client_id: lead?.client_id ?? null,
      survey_id: surveyId,
      estimator_id: estimatorId,
      title: input.title || (lead?.name ? `${input.apptType === "survey" ? "Survey" : "Removal"} — ${lead.name}` : input.apptType === "survey" ? "Survey" : "Removal"),
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      all_day: input.allDay ?? false,
      // The visit happens where the move starts — derived from the lead, not typed in.
      location: input.location || (lead ? lead.from_address || lead.from_postcode || null : null),
      notes: input.notes || null,
      status: "scheduled",
    })
    .select("id")
    .single();

  if (error) return { ok: false as const, error: error.message };

  // Removal with a packing day ticked → a second, crew-only appointment on the
  // same lead. Fail-soft: the removal is booked either way; a pack failure is
  // surfaced, never silently swallowed into a half-booked state.
  let packWarning: string | null = null;
  if (input.apptType === "removal" && input.packDate && /^\d{4}-\d{2}-\d{2}$/.test(input.packDate)) {
    const r = await upsertPackDay(sb, {
      leadId: input.leadId ?? null,
      clientId: lead?.client_id ?? null,
      leadName: lead?.name ?? null,
      location: lead ? lead.from_address || lead.from_postcode || null : null,
      packDay: input.packDate,
    });
    if (!r.ok) packWarning = r.error;
  }

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

  // Customer confirmation (survey only) — now gated on an explicit choice made
  // in the dialog. `notifyCustomer === false` means the office deliberately
  // chose not to write to this customer; anything else keeps the old default.
  let comms: SurveyCommsResult = { email: "skipped", sms: "skipped" };
  let noContact = false;
  if (input.apptType === "survey" && lead) {
    // No email AND no phone means nothing can be sent — report that honestly
    // rather than letting the UI show a bare "Survey booked" that reads as
    // "the customer has been told".
    const willNotify = input.notifyCustomer !== false;
    noContact = willNotify && !lead.email && !lead.phone;

    // The customer notice and the estimator notice touch nothing in common, so
    // they run together — booking a survey otherwise held the server action
    // open through two email sends, an SMS, a push fan-out and their reads.
    const [customerComms] = await Promise.all([
      willNotify
        ? sendSurveyCustomerNotice(sb, {
            kind: "booked",
            lead,
            estimatorId,
            startsAt: input.startsAt,
            location: input.location,
          })
        : Promise.resolve<SurveyCommsResult>({ email: "skipped", sms: "skipped" }),
      // The estimator's own heads-up — push + email, best-effort, never blocks.
      estimatorId
        ? notifyEstimatorOfSurvey({
            appointmentId: appt.id,
            estimatorUserId: estimatorId,
            kind: "booked",
            actorUserId: userId,
            startsAt: input.startsAt,
            leadId: lead.id,
            customerName: lead.name,
            customerPhone: lead.phone,
            address: input.location || lead.from_address || lead.from_postcode || null,
            notes: input.notes ?? null,
          })
        : Promise.resolve(null),
    ]);
    comms = customerComms;

    // A failed confirmation used to be a toast on a dialog that then closed.
    // Every other customer email in the system raises an ops alert when it
    // fails; this one now does too, so it survives the click.
    if (comms.email === "failed" || comms.sms === "failed") {
      const failed = [comms.email === "failed" ? "email" : null, comms.sms === "failed" ? "SMS" : null]
        .filter(Boolean)
        .join(" + ");
      await sendOpsAlert(`Survey confirmation ${failed} failed — ${lead.name ?? lead.id}`, [
        `A survey was booked for ${ukSlotLabel(input.startsAt) ?? input.startsAt} but the confirmation ${failed} did not send.`,
        `Send it from the lead's Comms tab, or call them.`,
      ], "system");
    }
  }

  revalidateSchedule();
  return { ok: true as const, id: appt.id, comms, packWarning, surveyWarning, noContact };
}

/**
 * Should a diary-level cancel/delete of this REMOVAL be refused?
 *
 * The diary paths only cascade the pack day. They do NOT email the customer,
 * void the Zoho invoices, pause the chase engine, stamp
 * `quotes.booking_cancelled_at` or open a refund-queue row — and
 * `booking_cancelled_at` is the marker every money surface reads, so a booking
 * killed here kept receiving commitment and balance chases while its held
 * deposit had nothing queued to refund. `deleteAppointment` is worse again: it
 * hard-deletes the row, so there is not even a cancelled record left behind.
 *
 * Two deliberate narrowings, so the refusal can never become a dead end:
 *  - Only when a DEPOSIT has actually been paid. That is exactly the condition
 *    under which /bookings buckets the job out of `awaiting` and renders the
 *    Cancel control (lib/bookings/queue.ts) — refusing without an available
 *    alternative would leave a pencilled-in booking uncancellable anywhere.
 *  - Only for the EARLIEST live removal on the lead, which is the one /bookings
 *    surfaces. A duplicate row from a mis-book must stay removable here, or the
 *    recommended path would void invoices and apologise for a job still running.
 *
 * Returns the message to show, or null to allow.
 */
async function paidBookingBlocksDiaryRemoval(
  sb: Awaited<ReturnType<typeof createClient>>,
  appointmentId: string,
  leadId: string | null,
): Promise<string | null> {
  if (!leadId) return null;
  const { data: paidQuote } = await sb
    .from("quotes")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "accepted")
    .is("booking_cancelled_at", null)
    .not("deposit_paid_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (!paidQuote) return null;

  const { data: primary } = await sb
    .from("appointments")
    .select("id")
    .eq("lead_id", leadId)
    .eq("appt_type", "removal")
    .neq("status", "cancelled")
    .order("starts_at", { ascending: true })
    .order("id")
    .limit(1)
    .maybeSingle();
  if (primary && primary.id !== appointmentId) return null;

  return "This booking has money against it. Cancel it from Bookings so the customer is told, the invoices are voided and any refund is queued.";
}

/* ------------------------------------------------------------- pack days */

type Sb = Awaited<ReturnType<typeof createClient>>;

/** Create (or move) the lead's packing day. One scheduled pack per lead — a
 *  second call reschedules the existing one rather than stacking duplicates. */
async function upsertPackDay(
  sb: Sb,
  input: { leadId: string | null; clientId: string | null; leadName: string | null; location: string | null; packDay: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.leadId) return { ok: false, error: "A packing day needs a customer attached." };
  const todayUk = new Date().toLocaleDateString("en-CA", { timeZone: UK_TZ });
  if (input.packDay < todayUk) {
    return { ok: false, error: "The packing date is in the past — pick today or later." };
  }
  const [y, m, d] = input.packDay.split("-").map(Number);
  const startsAt = ukInstant(y, m, d, 9, 0).toISOString();
  const endsAt = ukInstant(y, m, d, 16, 0).toISOString();

  const moveExisting = async (packId: string) => {
    const { error } = await sb.from("appointments").update({ starts_at: startsAt, ends_at: endsAt }).eq("id", packId);
    if (error) return { ok: false as const, error: `Could not move the packing day: ${error.message}` };
    // New day → the night-before crew sheet must re-fire for whoever is on it.
    await sb.from("appointment_assignments").update({ reminded_at: null } as never).eq("appointment_id", packId);
    return { ok: true as const };
  };

  const findScheduledPack = async () => {
    const { data } = await sb
      .from("appointments")
      .select("id")
      .eq("lead_id", input.leadId!)
      .eq("appt_type", "pack" as never)
      .eq("status", "scheduled")
      .order("starts_at")
      .limit(1)
      .maybeSingle();
    return data;
  };

  const existing = await findScheduledPack();
  if (existing) return moveExisting(existing.id);

  // A pack must belong to a live booking — without this, an edit dialog left
  // open across a cancellation could resurrect a pack on a dead booking that
  // nothing would ever clean up.
  const { data: removal } = await sb
    .from("appointments")
    .select("id, brand")
    .eq("lead_id", input.leadId)
    .eq("appt_type", "removal")
    .eq("status", "scheduled")
    .limit(1)
    .maybeSingle();
  if (!removal) return { ok: false, error: "This booking is no longer scheduled — no packing day was added." };

  const { error } = await sb.from("appointments").insert({
    appt_type: "pack" as never,
    // Denormalised brand, copied from the sibling removal (itself set from
    // the parent lead at insert, PRD §3.2) — a pack day must colour like its
    // move on the diary.
    brand: removal.brand ?? DEFAULT_BRAND,
    lead_id: input.leadId,
    client_id: input.clientId,
    title: input.leadName ? `Packing — ${input.leadName}` : "Packing",
    location: input.location,
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: false,
    status: "scheduled",
  });
  if (error) {
    // 23505 = the one-scheduled-pack-per-lead index: another session inserted
    // first — treat it as ours to move (the upsert's whole point).
    if ((error as { code?: string }).code === "23505") {
      const winner = await findScheduledPack();
      if (winner) return moveExisting(winner.id);
    }
    return { ok: false, error: `Could not add the packing day: ${error.message}` };
  }
  return { ok: true };
}

/** Set, move or remove the packing day for a removal's lead — the edit-dialog
 *  path. `packDay: null` cancels any scheduled pack (never deletes: mirrors
 *  the cancel-not-delete rule for appointments with history). */
export async function setPackDayAction(
  leadId: string,
  packDay: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { sb } = await ctx();
  if (packDay === null) {
    const { error } = await sb
      .from("appointments")
      .update({ status: "cancelled" as never })
      .eq("lead_id", leadId)
      .eq("appt_type", "pack" as never)
      .eq("status", "scheduled");
    if (error) return { ok: false, error: error.message };
    revalidateSchedule();
    revalidatePath("/schedule");
    return { ok: true };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(packDay)) return { ok: false, error: "Pick a valid packing date." };
  const { data: lead } = await sb
    .from("leads")
    .select("id, client_id, name, from_address, from_postcode")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "Lead not found." };
  const r = await upsertPackDay(sb, {
    leadId: lead.id,
    clientId: lead.client_id,
    leadName: lead.name,
    location: lead.from_address || lead.from_postcode || null,
    packDay,
  });
  if (!r.ok) return r;
  revalidateSchedule();
  revalidatePath("/schedule");
  return { ok: true };
}

export async function rescheduleAppointment(
  id: string,
  startsAt: string,
  endsAt: string,
  opts?: {
    /**
     * Tell the customer their survey has moved. Defaults to true — before
     * 2026-08-08 a reschedule sent NOTHING, so the customer kept an email for
     * a time we no longer intended to turn up (Peter: "Reschedule: doesn't
     * resend an email"). Removals are unaffected either way: their customer
     * email is owned by changeBookingDateAction, which calls this function.
     */
    notifyCustomer?: boolean;
  },
) {
  const { sb, userId } = await ctx();
  // Capture the old slot AND the routing fields BEFORE the update — the old
  // start is needed to re-arm reminders and to tell the customer what moved,
  // and appt_type/lead_id/estimator_id do not change during a reschedule.
  const { data: before } = await sb
    .from("appointments")
    .select("starts_at, appt_type, lead_id, estimator_id, location, notes, status")
    .eq("id", id)
    .maybeSingle();
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
  const appt = before;
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

    // The packing day travels WITH its move: shift the lead's scheduled pack
    // appointments by the same day delta so "the day before" stays the day
    // before. Fail-soft: a pack shift failure never blocks the reschedule,
    // but the office is told (a stranded pack day misleads crew + capacity).
    if (oldDay && oldDay !== newDay) {
      await shiftPackDays(sb, appt.lead_id, dayDelta(oldDay, newDay), id);
    }
  }

  // A moved SURVEY now tells the two people who need to know. Removals are
  // excluded on purpose: changeBookingDateAction owns their customer email and
  // calls this function, so sending here would double-mail them.
  // Only an actual change of START is news. A resize (drag the bottom edge to
  // make the visit longer) leaves the start alone, and without this the
  // customer got "Your survey has moved" naming the time it was already at,
  // plus a billable SMS.
  // Compared as instants, not strings: Postgres returns "+00:00" where the
  // client sends "Z", so a raw string compare would call every resize a move.
  const startMoved = (() => {
    const was = before?.starts_at ? Date.parse(before.starts_at) : NaN;
    const now = Date.parse(startsAt);
    if (!Number.isFinite(was) || !Number.isFinite(now)) return true; // unsure → tell them
    return was !== now;
  })();

  let comms: SurveyCommsResult = { email: "skipped", sms: "skipped" };
  if (appt?.appt_type === "survey" && appt.lead_id && appt.status !== "cancelled" && startMoved) {
    const { data: lead } = await sb
      .from("leads")
      .select("id, client_id, name, phone, email, from_address, from_postcode")
      .eq("id", appt.lead_id)
      .maybeSingle();
    if (lead) {
      if (opts?.notifyCustomer !== false) {
        comms = await sendSurveyCustomerNotice(sb, {
          kind: "moved",
          lead,
          estimatorId: appt.estimator_id ?? null,
          startsAt,
          location: appt.location,
          previousStartsAt: before?.starts_at ?? null,
        });
      }
      if (appt.estimator_id) {
        await notifyEstimatorOfSurvey({
          appointmentId: id,
          estimatorUserId: appt.estimator_id,
          kind: "moved",
          actorUserId: userId,
          startsAt,
          previousStartsAt: before?.starts_at ?? null,
          leadId: lead.id,
          customerName: lead.name,
          customerPhone: lead.phone,
          address: appt.location || lead.from_address || lead.from_postcode || null,
          notes: appt.notes ?? null,
        });
      }
    }
  }

  revalidateSchedule();
  return { ok: true as const, comms };
}

export async function updateAppointment(
  id: string,
  patch: { title?: string; location?: string; notes?: string; status?: string; estimatorId?: string | null },
  opts?: {
    /** Tell the customer their survey is cancelled. Same explicit gate as the
     *  booking and reschedule paths. */
    notifyCustomer?: boolean;
  },
) {
  const { sb, userId } = await ctx();
  // Snapshot the estimator BEFORE the write so a reassignment can tell both the
  // person losing the visit and the person gaining it. Until 2026-08-08 this
  // silently re-pointed who turns up at a customer's door and told nobody —
  // not the old estimator, not the new one, and not the customer, whose
  // confirmation email names the estimator by first name.
  const { data: prior } = await sb
    .from("appointments")
    .select("appt_type, lead_id, estimator_id, starts_at, location, notes, status, survey_id")
    .eq("id", id)
    .maybeSingle();

  if (patch.status === "cancelled" && prior?.appt_type === "removal") {
    const blocked = await paidBookingBlocksDiaryRemoval(sb, id, prior.lead_id);
    if (blocked) return { ok: false as const, error: blocked };
  }

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

  // Estimator changed on a live survey → tell both sides. The survey row's own
  // estimator_id is re-pointed with it (it was written once at booking and then
  // left to rot, so pay/attribution reads could disagree with the diary).
  const estimatorChanged =
    patch.estimatorId !== undefined && prior?.estimator_id !== patch.estimatorId;
  if (estimatorChanged && prior?.appt_type === "survey") {
    if (prior.survey_id) {
      await sb.from("surveys").update({ estimator_id: patch.estimatorId }).eq("id", prior.survey_id);
    }
    const { data: lead } = prior.lead_id
      ? await sb
          .from("leads")
          .select("id, name, phone, from_address, from_postcode")
          .eq("id", prior.lead_id)
          .maybeSingle()
      : { data: null };
    const shared = {
      appointmentId: id,
      actorUserId: userId,
      startsAt: prior.starts_at,
      leadId: prior.lead_id ?? null,
      customerName: lead?.name ?? null,
      customerPhone: lead?.phone ?? null,
      address: prior.location || lead?.from_address || lead?.from_postcode || null,
      notes: prior.notes ?? null,
    };
    if (prior.estimator_id) {
      await notifyEstimatorOfSurvey({ ...shared, estimatorUserId: prior.estimator_id, kind: "removed" });
    }
    if (patch.estimatorId) {
      await notifyEstimatorOfSurvey({ ...shared, estimatorUserId: patch.estimatorId, kind: "booked" });
    }
  }

  // Cancelling a REMOVAL cancels its packing day too — an appointment-level
  // cancel (view-modal action) bypasses cancelBookingAction's lead-wide sweep,
  // and a surviving pack would keep consuming crew, render on the board and
  // still send the crew to a cancelled customer.
  let cancelComms: SurveyCommsResult = { email: "skipped", sms: "skipped" };
  if (patch.status === "cancelled" && prior) {
    if (prior.appt_type === "removal" && prior.lead_id) {
      await sb
        .from("appointments")
        .update({ status: "cancelled" as never })
        .eq("lead_id", prior.lead_id)
        .eq("appt_type", "pack" as never)
        .eq("status", "scheduled");
    }

    // A cancelled SURVEY has to reach the customer — they are holding an email
    // and a text saying someone is coming to their house on a named day, and
    // until now nothing ever retracted it. Worst case of the whole set: they
    // take a morning off for a visit that was called off days earlier.
    if (prior.appt_type === "survey" && prior.lead_id) {
      const { data: lead } = await sb
        .from("leads")
        .select("id, client_id, status, name, phone, email, from_address, from_postcode")
        .eq("id", prior.lead_id)
        .maybeSingle();
      if (lead) {
        if (opts?.notifyCustomer !== false) {
          cancelComms = await sendSurveyCustomerNotice(sb, {
            kind: "cancelled",
            lead,
            estimatorId: prior.estimator_id ?? null,
            startsAt: prior.starts_at,
            location: prior.location,
          });
        }
        if (prior.estimator_id) {
          await notifyEstimatorOfSurvey({
            appointmentId: id,
            estimatorUserId: prior.estimator_id,
            kind: "cancelled",
            actorUserId: userId,
            startsAt: prior.starts_at,
            leadId: lead.id,
            customerName: lead.name,
            customerPhone: lead.phone,
            address: prior.location || lead.from_address || lead.from_postcode || null,
            notes: prior.notes ?? null,
          });
        }
        // The forward move (website_enquiry → survey_booked) had no inverse, so
        // a cancelled survey left the lead parked in the Board's Survey column
        // and counted in the "surveys due" preset forever, with no date on the
        // card. Undo it only in the exact shape the forward move created: still
        // survey_booked, no other live survey, no quote yet.
        if (lead.status === "survey_booked") {
          const [{ data: otherSurvey }, { data: anyQuote }] = await Promise.all([
            sb
              .from("appointments")
              .select("id")
              .eq("lead_id", lead.id)
              .eq("appt_type", "survey")
              .eq("status", "scheduled")
              .limit(1)
              .maybeSingle(),
            // Drafts don't count: an abandoned draft would pin the lead at
            // survey_booked with no survey — the exact state this undoes.
            sb.from("quotes").select("id").eq("lead_id", lead.id).neq("status", "draft").limit(1).maybeSingle(),
          ]);
          if (!otherSurvey && !anyQuote) {
            await sb.from("leads").update({ status: "website_enquiry" as never }).eq("id", lead.id);
          }
        }
        // The survey record must not stay "scheduled" once the visit is off —
        // but survey rows are now shared (appointments.survey_id has no unique
        // index and reuse makes 1:N normal), so only mark it cancelled when no
        // OTHER live survey appointment still points at it. Otherwise the lead
        // page would read "Survey record: cancelled" over a booking that is
        // still going ahead.
        if (prior.survey_id) {
          const { data: stillLive } = await sb
            .from("appointments")
            .select("id")
            .eq("survey_id", prior.survey_id)
            .eq("status", "scheduled")
            .neq("id", id)
            .limit(1)
            .maybeSingle();
          if (!stillLive) {
            await sb.from("surveys").update({ status: "cancelled" }).eq("id", prior.survey_id);
          }
        }
        revalidatePath(`/leads/${lead.id}`);
        revalidatePath("/leads");
      }
    }
  }

  // Survey done → the next step is the quote. If the lead has no quote yet,
  // queue a "build the quote" follow-up so completed surveys can't go cold.
  if (patch.status === "completed") {
    const { data: appt } = await sb
      .from("appointments")
      .select("appt_type, lead_id, client_id, estimator_id")
      .eq("id", id)
      .maybeSingle();
    if (appt?.appt_type === "survey" && appt.lead_id) {
      // Stamp the survey record itself. Nothing wrote this before, so every
      // lead that had ever had a survey rendered "Survey record: scheduled"
      // forever on the lead page — and the "a completed survey is history"
      // guard in createAppointment had nothing to match on, so a genuine
      // second visit still reused (and inherited the photos of) the first.
      if (prior?.survey_id) {
        await sb.from("surveys").update({ status: "completed" }).eq("id", prior.survey_id);
      }
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
        await sb.from("follow_ups").insert({
          lead_id: appt.lead_id,
          client_id: appt.client_id,
          reason: "quote_followup",
          due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          assigned_to: appt.estimator_id,
          created_by: userId,
          source: "survey_completed",
          notes: "Survey completed — build and send the quote.",
        } as never);
        revalidatePath("/follow-ups");
      }
    }
  }

  revalidateSchedule();
  return { ok: true as const, comms: cancelComms };
}

export async function deleteAppointment(id: string) {
  const { sb } = await ctx();
  // Snapshot BEFORE the delete — a removal's packing day must not outlive it
  // (same rationale as the cancel cascade above).
  const { data: target } = await sb
    .from("appointments")
    .select("appt_type, lead_id")
    .eq("id", id)
    .maybeSingle();

  // Delete is strictly WORSE than cancel — it destroys the row rather than
  // marking it — so it gets the same money guard. Without this, refusing at
  // Cancel just pushed the office one click across to Edit → Delete and the
  // booking vanished with no email, no void, no refund queue and no history.
  if (target?.appt_type === "removal") {
    const blocked = await paidBookingBlocksDiaryRemoval(sb, id, target.lead_id);
    if (blocked) return { ok: false as const, error: blocked };
  }

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
  if (target?.appt_type === "removal" && target.lead_id) {
    await sb
      .from("appointments")
      .update({ status: "cancelled" as never })
      .eq("lead_id", target.lead_id)
      .eq("appt_type", "pack" as never)
      .eq("status", "scheduled");
  }
  revalidateSchedule();
  return { ok: true as const };
}
