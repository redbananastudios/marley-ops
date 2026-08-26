"use server";

/**
 * Booking date change + cancellation — the single path (Payments Policy v2,
 * docs/payments-policy-v2-prd.md §5C).
 *
 *  changeBookingDateAction   OUTSIDE the 7-day window → free reschedule:
 *                            delegates to rescheduleAppointment (which now also
 *                            recomputes the commitment due date) and sends the
 *                            date-change-confirmation email. No queue entry.
 *                            INSIDE the window → cancel-and-rebook: the old
 *                            removal is CAS-cancelled (never deleted), a new
 *                            appointment is booked on the same lead + quote,
 *                            money dates roll, held money is snapshotted into a
 *                            refund_queue row (trigger customer_date_change) and
 *                            the cancellation-ack email goes out. NO second
 *                            deposit is ever taken.
 *
 *  cancelBookingAction       by:'customer' → routes through markLeadLostAction
 *                            (the one cancellation unwind — reason recorded,
 *                            invoices voided, queue row created there).
 *                            by:'marley'   → cancels future appointments, voids
 *                            unpaid invoices, creates an UNCONDITIONAL queue
 *                            row (trigger marley_cancel — no fill question) and
 *                            sends the apology/full-refund email. The lead's
 *                            status is deliberately untouched — mark it lost
 *                            separately if the job is dead for good.
 *
 * House rules honoured throughout: single-winner CAS on every state flip (0
 * rows = someone else won → skip side effects; a DB error is a FAILURE), every
 * money-state change writes BOTH an activities row and an events_log row, every
 * side effect is fail-soft with sendOpsAlert, all emails go via dispatchComm
 * from accountsFrom(), and no customer-facing string says "penalty".
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOfficeProfile } from "@/lib/ai/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchComm, sendOpsAlert } from "@/lib/comms/dispatch";
import { dayDelta } from "@/lib/schedule/pack-days";
import { shiftPackDays } from "@/lib/schedule/pack-days-io";
import { accountsFromFor } from "@/lib/comms/sender";
import { getBrandOrDefault, type Brand } from "@/lib/brand";
import { templateIdFor } from "@/lib/comms/template-id";
import { replyAddressFor, LOSS_REASONS } from "@/lib/quote/chase";
import { voidInvoice } from "@/lib/zoho";
import { balanceDueDate, moveDateLabel } from "@/lib/quote/payments";
import { ukInstant } from "@/lib/uk-time";
import { ukDayOf } from "@/lib/sales-report";
import { commitmentDueDate } from "@/lib/payments-policy";
import { buildHeldSnapshot, createRefundQueueEntry } from "@/lib/refunds";
import {
  bookingChangeMode,
  buildCancellationAckEmailHtml,
  buildDateChangeConfirmationEmailHtml,
  buildMarleyCancelEmailHtml,
  cancellationAckSubject,
  cancellationAckTemplateVars,
  cancellationAckText,
  dateChangeConfirmationSubject,
  dateChangeConfirmationTemplateVars,
  dateChangeConfirmationText,
  heldLines,
  marleyCancelSubject,
  marleyCancelTemplateVars,
  marleyCancelText,
  queueAmountsFor,
} from "@/lib/comms/cancellation-emails";
import { markLeadLostAction } from "@/app/(dashboard)/leads/actions";
import { rescheduleAppointment } from "@/app/(dashboard)/schedule/actions";

const uuid = z.string().uuid();

const isRealZohoId = (v: string | null | undefined): boolean => !!v && v !== "pending";

/** The quote columns every flow here needs off the money quote. */
const MONEY_QUOTE_COLS =
  "id, quote_ref, brand, customer_name, customer_email, accept_token, client_id, agreed_price, grand_total, moving_date, deposit_amount, deposit_paid_at, zoho_deposit_invoice_id, zoho_deposit_invoice_number, commitment_paid_at, commitment_invoice_amount, commitment_due_date, zoho_commitment_invoice_id, zoho_commitment_invoice_number, zoho_balance_invoice_id, zoho_balance_invoice_number";

interface MoneyQuote {
  id: string;
  quote_ref: string;
  /** Brand slug — resolves each customer email's copy, From and template set (§3.5). */
  brand: string;
  customer_name: string | null;
  customer_email: string | null;
  accept_token: string | null;
  client_id: string | null;
  agreed_price: number | null;
  grand_total: number | null;
  moving_date: string | null;
  deposit_amount: number | null;
  deposit_paid_at: string | null;
  zoho_deposit_invoice_id: string | null;
  zoho_deposit_invoice_number: string | null;
  commitment_paid_at: string | null;
  commitment_invoice_amount: number | null;
  commitment_due_date: string | null;
  zoho_commitment_invoice_id: string | null;
  zoho_commitment_invoice_number: string | null;
  zoho_balance_invoice_id: string | null;
  zoho_balance_invoice_number: string | null;
}

type Admin = ReturnType<typeof createAdminClient>;

async function acceptedQuoteFor(admin: Admin, leadId: string): Promise<MoneyQuote | null> {
  const { data } = await admin
    .from("quotes")
    .select(MONEY_QUOTE_COLS)
    .eq("lead_id", leadId)
    .eq("status", "accepted")
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as MoneyQuote | null) ?? null;
}

/** dd yyyy-mm-dd → "Monday 20 July" (customer emails). */
const dayLabel = (day: string | null | undefined): string | null => moveDateLabel(day ?? null);

function revalidateBookingSurfaces(leadId: string) {
  revalidatePath("/bookings");
  revalidatePath("/schedule/removals");
  revalidatePath("/follow-ups");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/refunds");
  revalidatePath("/");
}

/* ------------------------------------------------------- held summary (read) */

export interface HeldSummary {
  ok: true;
  total: number;
  conditional: number;
  unconditional: number;
  cap: number;
  lines: string[];
  dateConfirmed: boolean;
}

/**
 * Read-only held-money summary for the change/cancel dialogs — what is held,
 * how the 25% cap splits it, and whether the date was confirmed (pre-
 * confirmation nothing is retainable, so everything reads unconditional).
 */
export async function fetchHeldSummaryAction(
  leadId: string,
): Promise<HeldSummary | { ok: false; error: string }> {
  if (!uuid.safeParse(leadId).success) return { ok: false, error: "Invalid lead" };
  const office = await requireOfficeProfile();
  if (!office) return { ok: false, error: "Office access required." };

  const admin = createAdminClient();
  const [{ data: lead }, snapshot] = await Promise.all([
    admin.from("leads").select("id, date_confirmed_at").eq("id", leadId).maybeSingle(),
    buildHeldSnapshot(admin, leadId),
  ]);
  if (!lead) return { ok: false, error: "Lead not found." };

  const dateConfirmed = !!(lead as { date_confirmed_at: string | null }).date_confirmed_at;
  const amounts = queueAmountsFor(snapshot.split, dateConfirmed);
  return {
    ok: true,
    total: snapshot.split.total,
    conditional: amounts.conditional,
    unconditional: amounts.unconditional,
    cap: snapshot.split.cap,
    lines: heldLines(snapshot.held),
    dateConfirmed,
  };
}

/* ---------------------------------------------------------- date change */

export type ChangeBookingDateResult =
  | { ok: true; mode: "rescheduled" | "cancelled_and_rebooked"; newAppointmentId?: string; queued: boolean; emailed: boolean }
  | { ok: false; error: string; stale?: boolean };

export async function changeBookingDateAction(
  appointmentId: string,
  newStartsAt: string,
  newEndsAt: string,
  opts?: {
    /** The dialog's inside-window warning tick. SERVER-ENFORCED: the mode is
     *  recomputed here at submit time, so a tab opened before a UK-day
     *  boundary (client showed "free change", no tick rendered) can never
     *  slide into the destructive cancel-and-rebook unacknowledged. */
    acknowledgedInsideWindow?: boolean;
  },
): Promise<ChangeBookingDateResult> {
  if (!uuid.safeParse(appointmentId).success) return { ok: false, error: "Invalid appointment" };
  const office = await requireOfficeProfile();
  if (!office) return { ok: false, error: "Office access required." };

  const starts = new Date(newStartsAt);
  const ends = new Date(newEndsAt);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
    return { ok: false, error: "Pick a valid new date and time." };
  }
  if (ends.getTime() <= starts.getTime()) {
    return { ok: false, error: "The end time must be after the start time." };
  }

  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select(
      "id, appt_type, status, lead_id, client_id, estimator_id, starts_at, ends_at, title, location, notes, all_day, brand",
    )
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.appt_type !== "removal") {
    return { ok: false, error: "Only removal bookings go through the date-change flow — reschedule surveys from the diary." };
  }
  if (appt.status !== "scheduled") {
    return { ok: false, error: "This booking is no longer scheduled." };
  }
  if (!appt.lead_id) return { ok: false, error: "This booking has no lead attached." };
  const leadId = appt.lead_id;

  const oldMoveDay = ukDayOf(appt.starts_at);
  const newMoveDay = ukDayOf(newStartsAt);

  const [{ data: leadRow }, quote] = await Promise.all([
    admin
      .from("leads")
      .select("id, name, email, client_id, date_confirmed_at, brand")
      .eq("id", leadId)
      .maybeSingle(),
    acceptedQuoteFor(admin, leadId),
  ]);
  const lead = leadRow as
    | { id: string; name: string | null; email: string | null; client_id: string | null; date_confirmed_at: string | null; brand: string }
    | null;
  if (!lead) return { ok: false, error: "Lead not found." };

  const customerEmail = quote?.customer_email ?? lead.email ?? null;
  // ONE brand resolve per flow (multi-brand PRD §3.5) — the money quote's
  // brand wins, the lead's brand covers a quote-less edge; marley = today.
  const brand: Brand = await getBrandOrDefault(admin, quote?.brand ?? lead.brand);
  const replyTo = quote?.accept_token ? replyAddressFor(quote.accept_token, brand.name) : undefined;

  /* ----------------------------- OUTSIDE the window: free reschedule ------ */
  if (bookingChangeMode(oldMoveDay) === "reschedule") {
    // The reschedule path owns the money-date side effects (quotes.moving_date,
    // balance due date + follow-up, crew reminder re-arm) AND — as of Policy v2
    // — the commitment due-date recompute + its events_log/audit trail.
    const res = await rescheduleAppointment(appointmentId, newStartsAt, newEndsAt);
    if (!res.ok) return { ok: false, error: res.error };

    // Restate the held amounts to the customer (fail-soft — the reschedule
    // itself already happened).
    let emailed = false;
    if (customerEmail) {
      const snapshot = await buildHeldSnapshot(admin, leadId);
      const unpaidCommitment = !!quote && !quote.commitment_paid_at && isRealZohoId(quote.zoho_commitment_invoice_id);
      const meta = {
        firstName: lead.name ?? quote?.customer_name,
        quoteRef: quote?.quote_ref ?? "your booking",
        oldDateLabel: dayLabel(oldMoveDay),
        newDateLabel: dayLabel(newMoveDay),
        heldTotal: snapshot.split.total,
        heldLines: heldLines(snapshot.held),
        commitmentAmount: unpaidCommitment ? Number(quote?.commitment_invoice_amount ?? 0) : null,
        commitmentDueLabel: unpaidCommitment ? dayLabel(commitmentDueDate(newMoveDay)) : null,
        brand,
      };
      const templateId = templateIdFor(brand, "RESEND_TEMPLATE_DATE_CHANGE_CONFIRMATION");
      const sent = await dispatchComm(admin, office.id, {
        channel: "email",
        from: accountsFromFor(brand),
        to: customerEmail,
        subject: dateChangeConfirmationSubject(meta),
        bodyText: dateChangeConfirmationText(meta),
        ...(templateId
          ? { template: { id: templateId, variables: dateChangeConfirmationTemplateVars(meta) }, bodyHtml: buildDateChangeConfirmationEmailHtml(meta) }
          : { bodyHtml: buildDateChangeConfirmationEmailHtml(meta) }),
        replyTo,
        leadId,
        quoteId: quote?.id,
        clientId: lead.client_id ?? undefined,
        brand,
      }).catch(() => ({ ok: false as const, error: "send crashed" }));
      emailed = ("ok" in sent && sent.ok) || "duplicate" in sent;
      if (!emailed) {
        await sendOpsAlert(`Date-change confirmation email failed — ${quote?.quote_ref ?? leadId}`, [
          `The move was rescheduled to ${newMoveDay ?? newStartsAt} but the confirmation email to ${customerEmail} did not send. Re-send it from the lead page.`,
        ], "system");
      }
    }

    revalidateBookingSurfaces(leadId);
    return { ok: true, mode: "rescheduled", queued: false, emailed };
  }

  /* ------------------------ INSIDE the window: cancel-and-rebook ---------- */

  // 0. The acknowledgment is a server contract, not a client-render artifact:
  // if the caller didn't tick the inside-window warning (their tab computed
  // "outside" before the day ticked over), refuse BEFORE any state flips so
  // the dialog can re-render the warning + checkbox and ask properly.
  if (!opts?.acknowledgedInsideWindow) {
    return {
      ok: false,
      stale: true,
      error:
        "This booking is now within 7 days of its move date — the change releases the original day and holds money against it. Review the warning and tick the confirmation box to go ahead.",
    };
  }

  // 1. Single-winner CAS on the old appointment (cancelled, never deleted —
  // signed completions FK-RESTRICT the row). 0 rows = another window won.
  const { data: flipped, error: casError } = await admin
    .from("appointments")
    .update({ status: "cancelled" as never })
    .eq("id", appointmentId)
    .eq("status", "scheduled")
    .select("id");
  if (casError) return { ok: false, error: casError.message };
  if (!flipped?.length) {
    return { ok: false, stale: true, error: "This booking just changed in another window — try again." };
  }

  // 2. Book the new date on the same lead (same estimator, title, location).
  const { data: newAppt, error: insertError } = await admin
    .from("appointments")
    .insert({
      appt_type: "removal",
      // Same booking, same brand — carried from the appointment being
      // replaced (itself denormalised from the parent lead at insert,
      // PRD §3.2), so a re-dated job keeps its diary colour.
      brand: appt.brand,
      lead_id: leadId,
      client_id: appt.client_id ?? lead.client_id,
      estimator_id: appt.estimator_id,
      title: appt.title,
      location: appt.location,
      notes: appt.notes,
      all_day: appt.all_day,
      starts_at: newStartsAt,
      ends_at: newEndsAt,
      status: "scheduled",
    })
    .select("id")
    .single();
  if (insertError || !newAppt) {
    // Primary step failed — put the original booking back rather than leaving
    // the customer with no date at all.
    const { error: revertError } = await admin
      .from("appointments")
      .update({ status: "scheduled" as never })
      .eq("id", appointmentId)
      .eq("status", "cancelled");
    await sendOpsAlert(`Date change failed midway — ${quote?.quote_ref ?? leadId}`, [
      `Booking the new date failed (${insertError?.message ?? "no row returned"}).`,
      revertError
        ? `Restoring the original appointment ALSO failed (${revertError.message}) — the job currently has no scheduled removal. Fix the diary by hand.`
        : `The original appointment was restored — nothing changed for the customer.`,
    ], "system");
    return { ok: false, error: "Could not book the new date — the original booking was left in place." };
  }

  // 3. Money dates roll with the move (replicating rescheduleAppointment's
  // side effects — this path can't call it because the old row is cancelled).
  // Each write is fail-soft: the rebook itself already happened.
  const sideEffectFailures: string[] = [];
  if (quote && newMoveDay && quote.moving_date !== newMoveDay) {
    const { error } = await admin.from("quotes").update({ moving_date: newMoveDay } as never).eq("id", quote.id);
    if (error) sideEffectFailures.push(`quotes.moving_date: ${error.message}`);
  }
  if (newMoveDay) {
    const dueDate = balanceDueDate(newMoveDay);
    const { error: leadError } = await admin
      .from("leads")
      .update({ balance_due_date: dueDate } as never)
      .eq("id", leadId);
    if (leadError) sideEffectFailures.push(`leads.balance_due_date: ${leadError.message}`);
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
    if (dm) {
      const dueAt = ukInstant(Number(dm[1]), Number(dm[2]), Number(dm[3]), 9, 0).toISOString();
      const { error: fuError } = await admin
        .from("follow_ups")
        .update({ due_at: dueAt })
        .eq("lead_id", leadId)
        .eq("reason", "balance")
        .eq("status", "open");
      if (fuError) sideEffectFailures.push(`balance follow-up: ${fuError.message}`);
    }
  }
  // Re-arm the night-before crew reminder on the new booking. Assignments do
  // not carry over from the cancelled date today (crew is re-assigned on the
  // Job Board) — this is a deliberate no-op that keeps parity with
  // rescheduleAppointment if assignment-copying ever arrives.
  await admin
    .from("appointment_assignments")
    .update({ reminded_at: null } as never)
    .eq("appointment_id", newAppt.id);

  // The crew member who WAS on the old date is told by the Job Board's own
  // rail — the night-before job sheet, which re-sends as "Updated job sheet"
  // whenever the day's content changes and sends a "you're now clear" sheet
  // to anyone whose jobs all went away. Realtime allocation pushes were
  // retired (Peter, 2026-08-23) so crew have ONE authoritative channel rather
  // than two that can disagree. /my-jobs also shows a "Called off" card.

  // The packing day travels with its move (same rule as the free-reschedule
  // path): shift the lead's scheduled packs by the same day delta. Fail-soft —
  // shiftPackDays alerts the office itself if a pack could not be moved.
  if (oldMoveDay && newMoveDay && oldMoveDay !== newMoveDay) {
    await shiftPackDays(admin, leadId, dayDelta(oldMoveDay, newMoveDay), newAppt.id);
  }

  // The commitment ladder's one-shot stamps are per MOVE DATE, not per quote:
  // moving the date re-arms the T-10 chase (email/call task fires again for
  // the new date) and drops the now-stale T-7 "date at risk" flag — the cron
  // re-stamps both at the new date's thresholds. A paid commitment is history
  // and never touched.
  if (quote && !quote.commitment_paid_at && newMoveDay && newMoveDay !== oldMoveDay) {
    const { error: stampError } = await admin
      .from("quotes")
      .update({ commitment_chase_t10_at: null, date_releasable_at: null } as never)
      .eq("id", quote.id)
      .is("commitment_paid_at", null);
    if (stampError) sideEffectFailures.push(`commitment chase stamps: ${stampError.message}`);
  }

  // 4. Commitment due date recomputes against the NEW date (unpaid only — a
  // paid commitment is history). Zoho has no invoice-update helper, so a real
  // -COM invoice gets a manual-adjustment alert to the money desk.
  if (quote && !quote.commitment_paid_at && (quote.commitment_due_date || isRealZohoId(quote.zoho_commitment_invoice_id))) {
    const newDue = commitmentDueDate(newMoveDay);
    if (newDue !== quote.commitment_due_date) {
      const { error } = await admin
        .from("quotes")
        .update({ commitment_due_date: newDue } as never)
        .eq("id", quote.id)
        .is("commitment_paid_at", null);
      if (error) {
        sideEffectFailures.push(`commitment_due_date: ${error.message}`);
      } else {
        await admin.from("events_log").insert({
          actor_id: office.id,
          entity_type: "quote",
          entity_id: quote.id,
          action: "commitment_due_date_recomputed",
          diff: { moving_date: newMoveDay, from: quote.commitment_due_date, to: newDue } as never,
        });
        if (isRealZohoId(quote.zoho_commitment_invoice_id)) {
          await sendOpsAlert(`Adjust commitment invoice due date — ${quote.quote_ref}`, [
            `The move date changed, so commitment invoice ${quote.zoho_commitment_invoice_number ?? `${quote.quote_ref}-COM`} is now due ${newDue}.`,
            `Zoho invoice due dates can't be updated from the panel — adjust it manually in Zoho.`,
          ], "money");
        }
      }
    }
  }
  if (sideEffectFailures.length) {
    await sendOpsAlert(`Date-change side effects incomplete — ${quote?.quote_ref ?? leadId}`, [
      `The rebook to ${newMoveDay ?? newStartsAt} succeeded but some money-date updates failed:`,
      ...sideEffectFailures,
      `Check the quote/lead dates by hand.`,
    ], "system");
  }

  // 5. Snapshot what's held and park it in the refund queue. The fill question
  // is about the OLD date; held money provisionally counts toward the new
  // booking (no second deposit, ever).
  const snapshot = await buildHeldSnapshot(admin, leadId);
  let queued = false;
  // A queue row exists to answer the fill question — which only matters once
  // the date was CONFIRMED (pre-confirmation nothing is ever retainable, so
  // there is no decision to make and no rail may ever pay out on a live
  // booking: the money simply keeps counting toward the new date, PRD §1).
  // Creating a row there put £0-conditional entries straight into "To
  // execute" as a full cash refund of a live booking — the exact defect the
  // trigger-aware plan + this gate close.
  if (snapshot.held.length && lead.date_confirmed_at) {
    const amounts = queueAmountsFor(snapshot.split, true);
    const res = await createRefundQueueEntry(admin, {
      leadId,
      quoteId: snapshot.quote?.id ?? quote?.id ?? null,
      trigger: "customer_date_change",
      held: snapshot.held,
      conditionalAmount: amounts.conditional,
      unconditionalAmount: amounts.unconditional,
      originalMoveDate: oldMoveDay,
      oldAppointmentId: appointmentId,
      newAppointmentId: newAppt.id,
      determination: null,
      actorId: office.id,
      clientId: lead.client_id ?? quote?.client_id ?? null,
      customerName: lead.name ?? quote?.customer_name ?? null,
      quoteRef: snapshot.quote?.quote_ref ?? quote?.quote_ref ?? null,
      notes:
        "Inside-window date change — held money provisionally counts toward the new booking. Re-booked: it all keeps counting (nothing pays out). Stayed empty: the retained slice stops counting and the shortfall is stated for the balance invoice.",
    });
    queued = res.ok;
  }

  // 6. Cancellation-ack email (held-against-your-date framing + the refund SLA).
  let emailed = false;
  if (customerEmail) {
    const dateConfirmed = !!lead.date_confirmed_at;
    const amounts = queueAmountsFor(snapshot.split, dateConfirmed);
    const meta = {
      firstName: lead.name ?? quote?.customer_name,
      quoteRef: quote?.quote_ref ?? "your booking",
      oldDateLabel: dayLabel(oldMoveDay),
      newDateLabel: dayLabel(newMoveDay),
      heldTotal: snapshot.split.total,
      conditionalAmount: amounts.conditional,
      unconditionalAmount: amounts.unconditional,
      heldLines: heldLines(snapshot.held),
      dateConfirmed,
      brand,
    };
    const templateId = templateIdFor(brand, "RESEND_TEMPLATE_CANCELLATION_ACK");
    const sent = await dispatchComm(admin, office.id, {
      channel: "email",
      from: accountsFromFor(brand),
      to: customerEmail,
      subject: cancellationAckSubject(meta),
      bodyText: cancellationAckText(meta),
      ...(templateId
        ? { template: { id: templateId, variables: cancellationAckTemplateVars(meta) }, bodyHtml: buildCancellationAckEmailHtml(meta) }
        : { bodyHtml: buildCancellationAckEmailHtml(meta) }),
      replyTo,
      leadId,
      quoteId: quote?.id,
      clientId: lead.client_id ?? undefined,
      brand,
    }).catch(() => ({ ok: false as const, error: "send crashed" }));
    emailed = ("ok" in sent && sent.ok) || "duplicate" in sent;
    if (!emailed) {
      await sendOpsAlert(`Date-change acknowledgment email failed — ${quote?.quote_ref ?? leadId}`, [
        `The inside-window date change went through but the acknowledgment email to ${customerEmail} did not send. Re-send it from the lead page.`,
      ], "system");
    }
  }

  // 7. Timeline + audit pair for the money-state change (fail-soft each).
  const heldTotal = snapshot.split.total;
  const { error: activityError } = await admin.from("activities").insert({
    lead_id: leadId,
    client_id: lead.client_id ?? null,
    actor_id: office.id,
    type: "note",
    summary: `Move date changed inside the 7-day window — ${oldMoveDay ?? "old date"} released, rebooked for ${newMoveDay ?? "new date"}${
      heldTotal > 0 ? ` · £${heldTotal.toFixed(2)} held against the original date` : ""
    }`,
    meta: {
      old_appointment_id: appointmentId,
      new_appointment_id: newAppt.id,
      old_move_date: oldMoveDay,
      new_move_date: newMoveDay,
      held_total: heldTotal,
      refund_queue_created: queued,
    },
  });
  const { error: eventError } = await admin.from("events_log").insert({
    actor_id: office.id,
    entity_type: "appointment",
    entity_id: appointmentId,
    action: "cancelled_for_date_change",
    diff: {
      new_appointment_id: newAppt.id,
      old_move_date: oldMoveDay,
      new_move_date: newMoveDay,
      held_total: heldTotal,
      refund_queue_created: queued,
    } as never,
  });
  if (activityError || eventError) {
    await sendOpsAlert(`Date-change audit trail incomplete — ${quote?.quote_ref ?? leadId}`, [
      activityError ? `Lead timeline write failed: ${activityError.message}` : "",
      eventError ? `events_log write failed: ${eventError.message}` : "",
    ].filter(Boolean), "system");
  }

  revalidateBookingSurfaces(leadId);
  return { ok: true, mode: "cancelled_and_rebooked", newAppointmentId: newAppt.id, queued, emailed };
}

/* ------------------------------------------------------------ cancellation */

export interface CancelBookingInput {
  /** Either id resolves the lead — pass whichever the surface has. */
  appointmentId?: string;
  leadId?: string;
  by: "customer" | "marley";
  /** Customer cancels: a LOSS_REASONS value (required). Marley cancels: ignored. */
  reason?: string;
  note?: string;
}

export type CancelBookingResult =
  | { ok: true; apptsCancelled: number; voidedInvoices: number; refundQueued: boolean }
  | { ok: false; error: string };

export async function cancelBookingAction(input: CancelBookingInput): Promise<CancelBookingResult> {
  const office = await requireOfficeProfile();
  if (!office) return { ok: false, error: "Office access required." };
  if (input.by !== "customer" && input.by !== "marley") {
    return { ok: false, error: "Say who is cancelling." };
  }

  const admin = createAdminClient();

  // Resolve the lead from whichever id the caller has.
  let leadId = input.leadId ?? null;
  if (!leadId && input.appointmentId) {
    if (!uuid.safeParse(input.appointmentId).success) return { ok: false, error: "Invalid appointment" };
    const { data: appt } = await admin
      .from("appointments")
      .select("lead_id")
      .eq("id", input.appointmentId)
      .maybeSingle();
    leadId = (appt?.lead_id as string | null) ?? null;
  }
  if (!leadId || !uuid.safeParse(leadId).success) {
    return { ok: false, error: "Could not find the lead behind this booking." };
  }

  /* -------- customer cancels: THE one unwind lives in markLeadLostAction --- */
  if (input.by === "customer") {
    const reason = input.reason ?? "";
    if (!LOSS_REASONS.some((r) => r.value === reason)) {
      return { ok: false, error: "Pick a cancellation reason." };
    }
    const res = await markLeadLostAction(leadId, reason, input.note);
    if (!res.ok) return { ok: false, error: res.error ?? "Could not cancel the booking." };
    revalidatePath("/refunds");
    return {
      ok: true,
      apptsCancelled: "apptsCancelled" in res ? (res.apptsCancelled ?? 0) : 0,
      voidedInvoices: "voidedInvoices" in res ? (res.voidedInvoices ?? 0) : 0,
      refundQueued: "refundTask" in res ? !!res.refundTask : false,
    };
  }

  /* ----------------- Marley cancels: full refund, no fill question --------- */

  const { data: leadRow } = await admin
    .from("leads")
    .select("id, name, email, client_id, status, balance_paid_at, date_confirmed_at, brand")
    .eq("id", leadId)
    .maybeSingle();
  const lead = leadRow as
    | { id: string; name: string | null; email: string | null; client_id: string | null; status: string; balance_paid_at: string | null; date_confirmed_at: string | null; brand: string }
    | null;
  if (!lead) return { ok: false, error: "Lead not found." };

  const quote = await acceptedQuoteFor(admin, leadId);

  // Free the diary (single-winner by construction — only scheduled rows flip)
  // and capture what we cancelled for the queue row's old-date anchor. The
  // window starts at the UK DAY start, not "now": a move-day cancel after the
  // slot's start time must still free the row, or the post-move sweep later
  // auto-completes (and review-requests) a move Marley pulled.
  const nowIso = new Date().toISOString();
  const todayUkDay = ukDayOf(nowIso) ?? nowIso.slice(0, 10);
  const dm2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayUkDay);
  const dayStartIso = dm2
    ? ukInstant(Number(dm2[1]), Number(dm2[2]), Number(dm2[3]), 0, 0).toISOString()
    : nowIso;
  const { data: cancelledAppts, error: cancelError } = await admin
    .from("appointments")
    .update({ status: "cancelled" as never })
    .eq("lead_id", leadId)
    .eq("status", "scheduled")
    .gte("starts_at", dayStartIso)
    .select("id, appt_type, starts_at");
  if (cancelError) return { ok: false, error: cancelError.message };
  const apptsCancelled = cancelledAppts?.length ?? 0;
  const cancelledRemoval = (cancelledAppts ?? [])
    .filter((a) => a.appt_type === "removal")
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))[0];

  // Idempotency gate: nothing flipped this call AND a Marley-cancel row
  // already exists for this lead → this cancellation already ran (double
  // press, a retry after an alert, or a colleague repeating it days later).
  // Re-running the unwind would re-snapshot, re-email and re-queue the same
  // money — skip everything and report the earlier run's outcome.
  if (apptsCancelled === 0) {
    const { data: priorMarley } = await admin
      .from("refund_queue")
      .select("id")
      .eq("lead_id", leadId)
      .eq("trigger", "marley_cancel")
      .limit(1)
      .maybeSingle();
    if (priorMarley) {
      revalidateBookingSurfaces(leadId);
      return { ok: true, apptsCancelled: 0, voidedInvoices: 0, refundQueued: false };
    }
  }

  // Stop every chase — we cancelled; the customer must never be chased for
  // commitment/balance on a move we pulled. Fail-soft.
  const { error: pauseError } = await admin
    .from("leads")
    .update({ chase_paused: true } as never)
    .eq("id", leadId);
  if (pauseError) {
    await sendOpsAlert(`Chase pause failed on Marley cancel — ${quote?.quote_ref ?? leadId}`, [
      `Marley cancelled but pausing the chase engine failed: ${pauseError.message}. Pause it manually on the lead.`,
    ], "system");
  }

  // Disarm the money quote: booking_cancelled_at is the cancellation marker
  // every money surface reads — /q stops rendering payment panels against the
  // voided invoices, and the chase cron's commitment sweep / T-7 flag skip the
  // dead booking (chase_paused deliberately does NOT suppress the T-7 flag,
  // so the pause alone is not enough). Fail-soft.
  if (quote) {
    const { error: cancelMarkError } = await admin
      .from("quotes")
      .update({ booking_cancelled_at: nowIso } as never)
      .eq("id", quote.id)
      .is("booking_cancelled_at", null);
    if (cancelMarkError) {
      await sendOpsAlert(`Cancellation marker failed on Marley cancel — ${quote.quote_ref}`, [
        `booking_cancelled_at could not be stamped (${cancelMarkError.message}) — the /q page may still show payment panels for this cancelled booking. Fix the quote row by hand.`,
      ], "system");
    }
  }
  const { data: openFus } = await admin
    .from("follow_ups")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "open");
  for (const fu of openFus ?? []) {
    await admin.from("follow_ups").update({ status: "cancelled", outcome: "cancelled" }).eq("id", fu.id);
  }

  // Void the unpaid invoices (-DEP / -COM / -BAL) — the mark-lost pattern,
  // fail-soft per invoice. Paid money is NEVER touched here; it goes to the
  // refund queue for a human to execute.
  let voidedInvoices = 0;
  if (quote) {
    const voidTargets: { id: string | null; number: string | null; label: string; unpaid: boolean }[] = [
      { id: quote.zoho_deposit_invoice_id, number: quote.zoho_deposit_invoice_number, label: "Deposit", unpaid: !quote.deposit_paid_at },
      { id: quote.zoho_commitment_invoice_id, number: quote.zoho_commitment_invoice_number, label: "Commitment", unpaid: !quote.commitment_paid_at },
      { id: quote.zoho_balance_invoice_id, number: quote.zoho_balance_invoice_number, label: "Balance", unpaid: !lead.balance_paid_at },
    ];
    for (const t of voidTargets) {
      if (!t.unpaid || !isRealZohoId(t.id)) continue;
      try {
        await voidInvoice(t.id!);
        voidedInvoices++;
        await admin.from("activities").insert({
          lead_id: leadId,
          client_id: lead.client_id ?? null,
          actor_id: office.id,
          type: "note",
          summary: `${t.label} invoice ${t.number ?? ""} voided — Marley cancelled the move`.replace(/\s+/g, " ").trim(),
          meta: { quote_id: quote.id, invoice_id: t.id },
        });
      } catch (err) {
        await sendOpsAlert(`Void on Marley cancel FAILED — ${quote.quote_ref}`, [
          `Voiding ${t.label.toLowerCase()} invoice ${t.number ?? ""} failed: ${err instanceof Error ? err.message : "unknown"}. Void it manually in Zoho.`,
        ], "system");
      }
    }
  }

  // Everything held refunds in full — an UNCONDITIONAL queue row. Marley rows
  // carry no determination (the /refunds page skips the fill question).
  const snapshot = await buildHeldSnapshot(admin, leadId);
  let refundQueued = false;
  if (snapshot.held.length) {
    const res = await createRefundQueueEntry(admin, {
      leadId,
      quoteId: snapshot.quote?.id ?? quote?.id ?? null,
      trigger: "marley_cancel",
      held: snapshot.held,
      conditionalAmount: 0,
      unconditionalAmount: snapshot.split.total,
      originalMoveDate: quote?.moving_date ?? ukDayOf(cancelledRemoval?.starts_at ?? null),
      oldAppointmentId: cancelledRemoval?.id ?? null,
      determination: null,
      actorId: office.id,
      clientId: lead.client_id ?? quote?.client_id ?? null,
      customerName: lead.name ?? quote?.customer_name ?? null,
      quoteRef: snapshot.quote?.quote_ref ?? quote?.quote_ref ?? null,
      notes: `Marley cancelled${input.note?.trim() ? ` — ${input.note.trim()}` : ""}. Refund everything in full.`,
    });
    refundQueued = res.ok;
  }

  // Apology email — full-refund copy when money is held (fail-soft).
  const customerEmail = quote?.customer_email ?? lead.email ?? null;
  if (customerEmail) {
    const brand: Brand = await getBrandOrDefault(admin, quote?.brand ?? lead.brand);
    const meta = {
      firstName: lead.name ?? quote?.customer_name,
      quoteRef: quote?.quote_ref ?? "your booking",
      moveDateLabel: dayLabel(quote?.moving_date ?? ukDayOf(cancelledRemoval?.starts_at ?? null)),
      refundTotal: snapshot.split.total,
      heldLines: heldLines(snapshot.held),
      brand,
    };
    const templateId = templateIdFor(brand, "RESEND_TEMPLATE_MARLEY_CANCEL");
    const sent = await dispatchComm(admin, office.id, {
      channel: "email",
      from: accountsFromFor(brand),
      to: customerEmail,
      subject: marleyCancelSubject(meta),
      bodyText: marleyCancelText(meta),
      ...(templateId
        ? { template: { id: templateId, variables: marleyCancelTemplateVars(meta) }, bodyHtml: buildMarleyCancelEmailHtml(meta) }
        : { bodyHtml: buildMarleyCancelEmailHtml(meta) }),
      replyTo: quote?.accept_token ? replyAddressFor(quote.accept_token, brand.name) : undefined,
      leadId,
      quoteId: quote?.id,
      clientId: lead.client_id ?? undefined,
      brand,
    }).catch(() => ({ ok: false as const, error: "send crashed" }));
    const emailed = ("ok" in sent && sent.ok) || "duplicate" in sent;
    if (!emailed) {
      await sendOpsAlert(`Marley-cancel apology email failed — ${quote?.quote_ref ?? leadId}`, [
        `The cancellation went through but the apology email to ${customerEmail} did not send. Re-send it from the lead page.`,
      ], "system");
    }
  }

  // Timeline + audit pair. The lead's funnel status is deliberately untouched
  // (mark it lost separately if the job is dead) — but the money state changed,
  // so both records are written.
  const { error: activityError } = await admin.from("activities").insert({
    lead_id: leadId,
    client_id: lead.client_id ?? null,
    actor_id: office.id,
    type: "note",
    summary: `Marley cancelled the move${apptsCancelled ? ` · ${apptsCancelled} appointment${apptsCancelled === 1 ? "" : "s"} cancelled` : ""}${voidedInvoices ? ` · ${voidedInvoices} invoice${voidedInvoices === 1 ? "" : "s"} voided` : ""}${
      snapshot.split.total > 0 ? ` · £${snapshot.split.total.toFixed(2)} full refund queued` : ""
    }`,
    meta: {
      cancelled_by: "marley",
      note: input.note?.trim() || null,
      appointments_cancelled: apptsCancelled,
      voided_invoices: voidedInvoices,
      refund_queue_created: refundQueued,
    },
  });
  const { error: eventError } = await admin.from("events_log").insert({
    actor_id: office.id,
    entity_type: "lead",
    entity_id: leadId,
    action: "marley_cancelled_booking",
    diff: {
      appointments_cancelled: apptsCancelled,
      voided_invoices: voidedInvoices,
      held_total: snapshot.split.total,
      refund_queue_created: refundQueued,
    } as never,
  });
  if (activityError || eventError) {
    await sendOpsAlert(`Marley-cancel audit trail incomplete — ${quote?.quote_ref ?? leadId}`, [
      activityError ? `Lead timeline write failed: ${activityError.message}` : "",
      eventError ? `events_log write failed: ${eventError.message}` : "",
    ].filter(Boolean), "system");
  }

  revalidateBookingSurfaces(leadId);
  return { ok: true, apptsCancelled, voidedInvoices, refundQueued };
}
