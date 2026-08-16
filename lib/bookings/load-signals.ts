import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { getBusinessSettings } from "@/lib/settings";
import { balanceDue } from "@/lib/quote/payments";
import { classifyBooking, type BookingBucket } from "@/lib/bookings/queue";

/**
 * One row per lead with an accepted quote — the booking money signals, loaded
 * ONCE and classified with the shared pure classifier. Extracted from the
 * Bookings page (2026-08-16) so /bookings and the /payments Due + Upcoming
 * tabs read the exact same ledger and can never drift on what a booking owes.
 */

/** UK calendar day of a timestamptz — the Job Board buckets by Europe/London
 *  day (lib/job-board.ts), so day deep-links must use this, never the raw
 *  UTC slice (an all-day Monday move during BST is stored 23:00Z Sunday). */
export const ukDayOfInstant = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" });

export interface BookingRow {
  quoteId: string;
  quoteRef: string;
  leadId: string;
  customer: string;
  agreed: number;
  deposit: number;
  depositPaidAt: string | null;
  depositSelfreportAt: string | null;
  commitmentPaidAt: string | null;
  commitmentInvoiceAmount: number;
  commitmentDueDate: string | null;
  dateReleasableAt: string | null;
  acceptedAt: string | null;
  acceptToken: string | null;
  movingDate: string | null;
  chasePaused: boolean;
  depositChaseStep: number;
  balancePaidAt: string | null;
  balanceInvoiceNumber: string | null;
  balanceAmount: number;
  apptId: string | null;
  apptStartsAt: string | null;
  apptEndsAt: string | null;
  crewAssigned: number;
  cardStatus: string | null;
  /** The money quote's own moving_date (no preferred-date fallback) — drives
   *  the date-confirmation chip, which must never claim a date the quote
   *  doesn't carry. */
  quoteMovingDate: string | null;
  /** leads.date_confirmed_at — the Payments Policy v2 ladder flag. */
  dateConfirmedAt: string | null;
  /** Pencilled move window (booking_details) — shown on provisional rows. */
  approxWindow: string | null;
  approxMonth: string | null;
  provisionalDate: string | null;
  propertyType: string | null;
  /** Imported iMVE booking — old-terms job, all money handling is manual. */
  legacy: boolean;
  bucket: BookingBucket;
}

export async function loadBookingRows(
  sb: SupabaseClient,
): Promise<{ rows: BookingRow[]; todayUk: string }> {
  const settings = await getBusinessSettings(sb);
  const todayUk = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  // Accepted quotes accumulate for the life of the business → page through
  // fetchAllRows (a plain select truncates at PostgREST's 1000-row cap). Rows
  // are re-sorted by accepted_at below, so id-order paging is fine.
  const quotes = await fetchAllRows((f, t) =>
    sb
      .from("quotes")
      .select(
        "id, quote_ref, source, lead_id, customer_name, agreed_price, grand_total, accepted_at, accept_token, moving_date, deposit_amount, deposit_paid_at, deposit_selfreport_at, commitment_paid_at, commitment_invoice_amount, commitment_due_date, date_releasable_at, zoho_balance_invoice_id, zoho_balance_invoice_number, balance_invoice_amount",
      )
      .eq("status", "accepted")
      .not("lead_id", "is", null)
      .order("id")
      .range(f, t),
  );

  const leadIds = [...new Set((quotes ?? []).map((q) => q.lead_id as string))];
  const [{ data: leads }, { data: appts }, { data: bookingDetails }] = await Promise.all([
    leadIds.length
      ? sb
          .from("leads")
          .select("id, name, status, preferred_date, chase_paused, deposit_chase_step, balance_paid_at, date_confirmed_at")
          .in("id", leadIds)
      : Promise.resolve({ data: [] as never[] }),
    leadIds.length
      ? sb
          .from("appointments")
          .select("id, lead_id, starts_at, ends_at, status")
          .eq("appt_type", "removal")
          // Crew sign-off flips the appointment to 'completed' on move day —
          // the booking row must keep its move date (only cancelled drops out).
          .in("status", ["scheduled", "completed"])
          .in("lead_id", leadIds)
      : Promise.resolve({ data: [] as never[] }),
    // Move-window capture — prefills the shared drawer and splits "no date"
    // from "provisional" in the queue.
    leadIds.length
      ? sb
          .from("booking_details")
          .select("lead_id, approx_window, approx_month, provisional_date, property_type")
          .in("lead_id", leadIds)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const bdByLead = new Map((bookingDetails ?? []).map((b) => [b.lead_id as string, b]));

  // Latest card-payment attempt per lead → a small "did they try to pay?" chip
  // on awaiting rows (the first question on a deposit chase call).
  const { data: cardAttempts } = leadIds.length
    ? await sb
        .from("card_payments")
        .select("lead_id, status, created_at")
        .in("lead_id", leadIds)
        .in("status", ["pending", "failed", "paid", "partially_refunded", "refunded", "voided"])
        .order("created_at", { ascending: false })
    : { data: [] as { lead_id: string | null; status: string; created_at: string }[] };
  const cardStatusByLead = new Map<string, string>();
  for (const a of cardAttempts ?? []) {
    if (a.lead_id && !cardStatusByLead.has(a.lead_id)) cardStatusByLead.set(a.lead_id, a.status);
  }

  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));
  // Earliest removal appointment per lead — id + slot so the booked rows can
  // open the change-date dialog against the actual diary entry.
  const apptByLead = new Map<string, { id: string; startsAt: string; endsAt: string | null }>();
  for (const a of appts ?? []) {
    const cur = apptByLead.get(a.lead_id as string);
    if (!cur || (a.starts_at as string) < cur.startsAt) {
      apptByLead.set(a.lead_id as string, {
        id: a.id as string,
        startsAt: a.starts_at as string,
        endsAt: (a.ends_at as string | null) ?? null,
      });
    }
  }

  // Crew assigned per appointment → the "confirmed, not allocated" flag.
  const apptIds = [...apptByLead.values()].map((a) => a.id);
  const { data: assignments } = apptIds.length
    ? await sb.from("appointment_assignments").select("appointment_id, staff_id").in("appointment_id", apptIds)
    : { data: [] as { appointment_id: string; staff_id: string | null }[] };
  const crewByAppt = new Map<string, number>();
  for (const a of assignments ?? []) {
    if (a.staff_id) crewByAppt.set(a.appointment_id, (crewByAppt.get(a.appointment_id) ?? 0) + 1);
  }

  // One row per lead: its most recently accepted quote drives the money.
  const rows: BookingRow[] = [];
  const seen = new Set<string>();
  const sorted = (quotes ?? []).sort((a, b) => (b.accepted_at ?? "").localeCompare(a.accepted_at ?? ""));
  for (const q of sorted) {
    const lead = leadById.get(q.lead_id as string);
    if (!lead || seen.has(lead.id)) continue;
    if (lead.status === "completed" || lead.status === "declined") continue;
    seen.add(lead.id);
    const agreed = Number(q.agreed_price ?? q.grand_total ?? 0);
    const deposit = Number(q.deposit_amount ?? settings.defaultDeposit);
    // Raised 25% commitment carved out of the balance, mirroring the
    // authoritative computeBalanceCredits (accept-flow.ts): the balance invoice
    // will be agreed − deposit − commitment. commitment_invoice_amount is
    // written atomically with the real Zoho id (only >0 once the -COM invoice
    // is raised), so it's the correct pre-invoice credit signal.
    const commitmentCredit = Number(q.commitment_invoice_amount ?? 0);
    const appt = apptByLead.get(lead.id) ?? null;
    const bd = bdByLead.get(lead.id);
    const row: Omit<BookingRow, "bucket"> = {
      quoteId: q.id,
      quoteRef: q.quote_ref,
      leadId: lead.id,
      customer: (q.customer_name || lead.name || "Customer") as string,
      agreed,
      deposit,
      depositPaidAt: q.deposit_paid_at,
      depositSelfreportAt: q.deposit_selfreport_at,
      commitmentPaidAt: (q.commitment_paid_at as string | null) ?? null,
      commitmentInvoiceAmount: commitmentCredit,
      commitmentDueDate: (q.commitment_due_date as string | null) ?? null,
      dateReleasableAt: (q.date_releasable_at as string | null) ?? null,
      acceptedAt: q.accepted_at,
      acceptToken: q.accept_token,
      movingDate: (q.moving_date || lead.preferred_date) as string | null,
      chasePaused: !!lead.chase_paused,
      depositChaseStep: Number(lead.deposit_chase_step ?? 0),
      balancePaidAt: lead.balance_paid_at as string | null,
      balanceInvoiceNumber:
        q.zoho_balance_invoice_id && q.zoho_balance_invoice_id !== "pending"
          ? (q.zoho_balance_invoice_number as string | null)
          : null,
      // Once the balance invoice is raised we trust its frozen amount; before
      // it exists, subtract BOTH the deposit and the raised commitment so the
      // displayed "outstanding" matches what createBalanceInvoiceFlow will
      // actually raise (agreed − deposit − commitment). balanceDue clamps ≥ 0.
      balanceAmount: Number(q.balance_invoice_amount ?? balanceDue(agreed, deposit + commitmentCredit)),
      apptId: appt?.id ?? null,
      apptStartsAt: appt?.startsAt ?? null,
      apptEndsAt: appt?.endsAt ?? null,
      crewAssigned: appt ? (crewByAppt.get(appt.id) ?? 0) : 0,
      cardStatus: cardStatusByLead.get(lead.id) ?? null,
      quoteMovingDate: (q.moving_date as string | null) ?? null,
      dateConfirmedAt: (lead.date_confirmed_at as string | null) ?? null,
      approxWindow: (bd?.approx_window as string | null) ?? null,
      approxMonth: (bd?.approx_month as string | null) ?? null,
      provisionalDate: (bd?.provisional_date as string | null) ?? null,
      propertyType: (bd?.property_type as string | null) ?? null,
      legacy: q.source === "imve",
    };
    rows.push({
      ...row,
      bucket: classifyBooking(
        {
          depositPaidAt: row.depositPaidAt,
          hasRemovalAppt: !!row.apptStartsAt,
          apptDayUk: row.apptStartsAt ? ukDayOfInstant(row.apptStartsAt) : null,
          provisionalDate: row.provisionalDate,
          approxWindow: row.approxWindow,
          approxMonth: row.approxMonth,
          commitmentPaidAt: row.commitmentPaidAt,
          commitmentInvoiceAmount: row.commitmentInvoiceAmount,
          commitmentDueDate: row.commitmentDueDate,
          dateReleasableAt: row.dateReleasableAt,
          balancePaidAt: row.balancePaidAt,
          balanceInvoiceNumber: row.balanceInvoiceNumber,
        },
        todayUk,
      ),
    });
  }

  return { rows, todayUk };
}
