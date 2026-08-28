import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { getBusinessSettings } from "@/lib/settings";
import { balanceDue } from "@/lib/quote/payments";
import { depositOfQuote } from "@/lib/payments-policy";
import { classifyBooking, owedNow, type BookingBucket, type OwedNow } from "@/lib/bookings/queue";

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

/**
 * Is the REMOVAL done? A commercial job is invoiced on completion, so this is a
 * money question, not just a diary one.
 *
 * It reads every removal appointment on the lead, not one of them. The earliest
 * appointment is the right answer to "when is the move" (it is the slot the
 * board shows and the change-date dialog opens), and it was being reused to
 * answer "is it finished" — which it cannot. A two-day job crewed Friday and
 * Saturday flips its FRIDAY entry to 'completed' at Friday's sign-off, so on
 * Friday evening the board read "completed — raise the invoice" for a job with
 * a van still going out in the morning. Multiple live removals on one lead are
 * ordinary here: the manual createAppointment path has no duplicate guard.
 *
 * The test is that NO appointment is still outstanding, which is stricter than
 * asking whether the latest one is signed off, and stricter in the safe
 * direction: out-of-order sign-off (Saturday closed, Friday forgotten) reads as
 * not-done, which parks the row in "awaiting completion" where the office can
 * see it. The opposite mistake invoices a job that is still running.
 *
 * The caller passes only scheduled/completed appointments — cancelled ones are
 * filtered out of the query, and a cancelled day is not work left to do. An
 * empty list is NOT complete: `every` is vacuously true, and a lead with no
 * diary entry at all has not finished anything.
 */
export function removalCompleted(appts: ReadonlyArray<{ status: string | null }>): boolean {
  return appts.length > 0 && appts.every((a) => a.status === "completed");
}

export interface BookingRow {
  quoteId: string;
  quoteRef: string;
  leadId: string;
  customer: string;
  /** Contact details, so the office payment link (gate 9d) can be offered
   *  only where there is somewhere to send it. */
  customerEmail: string | null;
  customerPhone: string | null;
  /** Snapshotted at acceptance (gate 8). Drives which LADDER this booking
   *  runs; never re-derived from the client. */
  paymentPolicy: "residential" | "commercial";
  /** Commercial only: when the completion invoice falls due, from the
   *  client's terms. Null until it is raised. */
  commercialDueDate: string | null;
  /** Commercial only: the removal appointment is completed, so the invoice
   *  can be raised. */
  jobCompleted: boolean;
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
  /** Money askable TODAY (25% + balance; never the deposit) — see owedNow. */
  owed: OwedNow;
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
        "id, quote_ref, source, standard_comms_at, status, brand, payment_policy, commercial_due_date, lead_id, customer_name, customer_email, customer_phone, agreed_price, grand_total, accepted_at, accept_token, moving_date, deposit_amount, deposit_paid_at, deposit_selfreport_at, commitment_paid_at, commitment_invoice_amount, commitment_due_date, date_releasable_at, zoho_balance_invoice_id, zoho_balance_invoice_number, balance_invoice_amount, booking_cancelled_at",
      )
      .eq("status", "accepted")
      // A cancelled booking owes nothing and expects nothing — its unwind
      // (void invoices, refund queue) owns the money from that point. Cancelling
      // does NOT flip the lead's status, so without this the job keeps showing
      // as money due and as expected income: a voided commitment invoice would
      // appear in the 4-week forecast, and the balance of a job we are actively
      // refunding would sit in the pencilled pipeline. Every other money
      // surface (sales report, dashboard) already reads this marker.
      .is("booking_cancelled_at", null)
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
  // open the change-date dialog against the actual diary entry. It deliberately
  // carries NO status: this entry answers "when is the move", and its status
  // answers "is the FIRST DAY done", which is not a question anything wants.
  // Reading it as though it were the whole job is the defect above.
  const apptByLead = new Map<
    string,
    { id: string; startsAt: string; endsAt: string | null }
  >();
  // ALL of them per lead, kept separately, because "when is the move" and "is
  // the move finished" are different questions and the earliest entry only
  // answers the first (see removalCompleted). The query already selects status
  // — it filters on scheduled|completed — it simply was not carried through.
  const apptsByLead = new Map<string, { status: string | null }[]>();
  for (const a of appts ?? []) {
    const leadId = a.lead_id as string;
    const status = (a.status as string | null) ?? null;
    const cur = apptByLead.get(leadId);
    if (!cur || (a.starts_at as string) < cur.startsAt) {
      apptByLead.set(leadId, {
        id: a.id as string,
        startsAt: a.starts_at as string,
        endsAt: (a.ends_at as string | null) ?? null,
      });
    }
    const all = apptsByLead.get(leadId);
    if (all) all.push({ status });
    else apptsByLead.set(leadId, [{ status }]);
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
    // Policy-aware: COMMERCIAL takes no deposit, so nothing is deducted from
    // its balance and `balanceAmount` below is the whole agreed price. The bare
    // `?? defaultDeposit` this replaces is what made the only commercial money
    // figure wrong — see depositOfQuote for the three shapes it produced.
    const deposit = depositOfQuote(
      q as { payment_policy?: string | null; deposit_amount?: number | null },
      settings.defaultDeposit,
    );
    // Raised 25% commitment carved out of the balance, mirroring the
    // authoritative computeBalanceCredits (accept-flow.ts): the balance invoice
    // will be agreed − deposit − commitment. commitment_invoice_amount is
    // written atomically with the real Zoho id (only >0 once the -COM invoice
    // is raised), so it's the correct pre-invoice credit signal.
    const commitmentCredit = Number(q.commitment_invoice_amount ?? 0);
    const appt = apptByLead.get(lead.id) ?? null;
    const bd = bdByLead.get(lead.id);
    const row: Omit<BookingRow, "bucket" | "owed"> = {
      quoteId: q.id,
      quoteRef: q.quote_ref,
      leadId: lead.id,
      customer: (q.customer_name || lead.name || "Customer") as string,
      customerEmail: (q.customer_email as string | null) ?? null,
      customerPhone: (q.customer_phone as string | null) ?? null,
      // Anything that is not explicitly 'commercial' runs the residential
      // ladder - the same direction of default as resolvePaymentPolicy, and
      // for the same reason: guessing commercial would silently switch a
      // booking's chase OFF, and the surface that would have shown the
      // mistake is the chase queue the guess just emptied.
      paymentPolicy: q.payment_policy === "commercial" ? "commercial" : "residential",
      commercialDueDate: (q.commercial_due_date as string | null) ?? null,
      jobCompleted: removalCompleted(apptsByLead.get(lead.id) ?? []),
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
    const hasRemovalAppt = !!row.apptStartsAt;
    const apptDayUk = row.apptStartsAt ? ukDayOfInstant(row.apptStartsAt) : null;
    rows.push({
      ...row,
      bucket: classifyBooking(
        {
          depositPaidAt: row.depositPaidAt,
          hasRemovalAppt,
          apptDayUk,
          provisionalDate: row.provisionalDate,
          approxWindow: row.approxWindow,
          approxMonth: row.approxMonth,
          commitmentPaidAt: row.commitmentPaidAt,
          commitmentInvoiceAmount: row.commitmentInvoiceAmount,
          commitmentDueDate: row.commitmentDueDate,
          dateReleasableAt: row.dateReleasableAt,
          balancePaidAt: row.balancePaidAt,
          balanceInvoiceNumber: row.balanceInvoiceNumber,
          paymentPolicy: row.paymentPolicy,
          jobCompleted: row.jobCompleted,
          commercialDueDate: row.commercialDueDate,
        },
        todayUk,
      ),
      // Computed ONCE, here, so /payments, /bookings and the dashboard tiles
      // all read the same figure. They previously each derived money their own
      // way and disagreed about the same job in the same week (QA-20260820-04).
      owed: owedNow(
        {
          commitmentInvoiceAmount: row.commitmentInvoiceAmount,
          commitmentPaidAt: row.commitmentPaidAt,
          commitmentDueDate: row.commitmentDueDate,
          dateReleasableAt: row.dateReleasableAt,
          balanceAmount: row.balanceAmount,
          balancePaidAt: row.balancePaidAt,
          balanceInvoiceNumber: row.balanceInvoiceNumber,
          hasRemovalAppt,
          apptDayUk,
          paymentPolicy: row.paymentPolicy,
          commercialDueDate: row.commercialDueDate,
        },
        todayUk,
      ),
    });
  }

  return { rows, todayUk };
}
