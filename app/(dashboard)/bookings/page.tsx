import Link from "next/link";
import { AlertTriangle, CalendarPlus, CheckCircle2, PauseCircle, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { getBusinessSettings } from "@/lib/settings";
import { acceptUrlFor } from "@/lib/quote/accept-flow";
import { balanceDue, moveDateLabel } from "@/lib/quote/payments";
import { classifyBooking, daysBetweenUk, type BookingBucket } from "@/lib/bookings/queue";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { BalanceInvoiceButton } from "@/components/leads/balance-invoice-button";
import { BookingDetailsButton } from "@/components/bookings/booking-details-dialog";
import { CopyLinkButton, MarkPaidButton } from "@/components/bookings/booking-actions";
import { CancelBookingButton, ChangeDateButton } from "@/components/bookings/booking-policy-actions";
import { DateConfirmStatus } from "@/components/quote/date-confirm-status";

/**
 * Bookings — the money/action queue between "quote accepted" and "removal
 * completed" (schedule-allocation-design.md §"Bookings page → money/action
 * queue"). Sections ARE the money lifecycle, so the page reads top-to-bottom
 * as "who needs acting on today":
 *
 *   £100 OUTSTANDING     accepted online, deposit unpaid (auto-chased d1/d3)
 *   ON THE LIST, NO DATE deposit paid, nothing pencilled — capture the window
 *   PROVISIONAL          deposit paid, window/date pencilled — sell the 25%
 *   25% OVERDUE          past due or date-at-risk flagged — call today
 *   25% TO COLLECT       invoiced, inside its due window
 *   BALANCE OVERDUE      moved with money outstanding — chase now
 *   BALANCE TO COLLECT   invoice → paid, due in full before move day
 *   BOOKED — ALL SET     nothing owed right now (change/cancel still here)
 *
 * "Confirmed, not allocated" is a CHIP + headline count (deep-links into
 * /schedule Day Allocation), never a bucket — allocation is orthogonal to
 * money and must not pull rows out of the queue. Bucket rules are pure and
 * tested: lib/bookings/queue.ts.
 */

export const dynamic = "force-dynamic";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** UK calendar day of a timestamptz — the Job Board buckets by Europe/London
 *  day (lib/job-board.ts), so day deep-links must use this, never the raw
 *  UTC slice (an all-day Monday move during BST is stored 23:00Z Sunday). */
const ukDayOf = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" });

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(iso: string | null): string {
  if (!iso) return "";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
}

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

interface Row {
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
  bucket: BookingBucket;
}

function Section({
  title,
  hint,
  count,
  tone,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  tone?: "danger";
  children: React.ReactNode;
}) {
  // An empty routine section renders as a one-line all-clear; an empty DANGER
  // section disappears entirely (a red header with "all clear" cries wolf).
  if (count === 0 && tone === "danger") return null;
  return (
    <Card className="p-0">
      <div
        className={`flex items-baseline gap-3 border-b px-5 py-3.5 ${tone === "danger" ? "border-danger-border bg-danger-bg/40" : ""}`}
      >
        <h2 className={`font-display text-lg ${tone === "danger" ? "text-danger" : "text-foreground"}`}>{title}</h2>
        <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
          {count}
        </span>
        <span className="ml-auto hidden text-xs text-mist-400 sm:block">{hint}</span>
      </div>
      {count === 0 ? (
        <p className="px-5 py-4 text-sm text-mist-400">Nothing here — all clear.</p>
      ) : (
        <div className="divide-y divide-mist-150">{children}</div>
      )}
    </Card>
  );
}

function Stat({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const inner = (
    <>
      <p className="eyebrow">{label}</p>
      <p className="tabular mt-1 font-display text-2xl font-bold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </>
  );
  return href ? (
    <Link href={href} className="focus-ring block">
      <Card className="px-5 py-4 transition-colors hover:bg-muted/40">{inner}</Card>
    </Link>
  ) : (
    <Card className="px-5 py-4">{inner}</Card>
  );
}

/** Amber "no crew yet" chip on booked rows — deep-links into Day Allocation. */
function AllocateChip({ day }: { day: string }) {
  return (
    <Link
      href={`/schedule?date=${day}&tab=alloc`}
      className="focus-ring inline-flex items-center gap-1 rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn transition-colors hover:brightness-95"
    >
      <Users className="size-3.5" strokeWidth={2} /> No crew — allocate
    </Link>
  );
}

export default async function BookingsPage() {
  const sb = await createClient();
  const settings = await getBusinessSettings(sb);
  const todayUk = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  // Accepted quotes accumulate for the life of the business → page through
  // fetchAllRows (a plain select truncates at PostgREST's 1000-row cap). Rows
  // are re-sorted by accepted_at below, so id-order paging is fine.
  const quotes = await fetchAllRows((f, t) =>
    sb
      .from("quotes")
      .select(
        "id, quote_ref, lead_id, customer_name, agreed_price, grand_total, accepted_at, accept_token, moving_date, deposit_amount, deposit_paid_at, deposit_selfreport_at, commitment_paid_at, commitment_invoice_amount, commitment_due_date, date_releasable_at, zoho_balance_invoice_id, zoho_balance_invoice_number, balance_invoice_amount",
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
  const rows: Row[] = [];
  const seen = new Set<string>();
  const sorted = (quotes ?? []).sort((a, b) => (b.accepted_at ?? "").localeCompare(a.accepted_at ?? ""));
  for (const q of sorted) {
    const lead = leadById.get(q.lead_id as string);
    if (!lead || seen.has(lead.id)) continue;
    if (lead.status === "completed" || lead.status === "declined") continue;
    seen.add(lead.id);
    const agreed = Number(q.agreed_price ?? q.grand_total ?? 0);
    const deposit = Number(q.deposit_amount ?? settings.defaultDeposit);
    const appt = apptByLead.get(lead.id) ?? null;
    const bd = bdByLead.get(lead.id);
    const row: Omit<Row, "bucket"> = {
      quoteId: q.id,
      quoteRef: q.quote_ref,
      leadId: lead.id,
      customer: (q.customer_name || lead.name || "Customer") as string,
      agreed,
      deposit,
      depositPaidAt: q.deposit_paid_at,
      depositSelfreportAt: q.deposit_selfreport_at,
      commitmentPaidAt: (q.commitment_paid_at as string | null) ?? null,
      commitmentInvoiceAmount: Number(q.commitment_invoice_amount ?? 0),
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
      balanceAmount: Number(q.balance_invoice_amount ?? balanceDue(agreed, deposit)),
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
    };
    rows.push({
      ...row,
      bucket: classifyBooking(
        {
          depositPaidAt: row.depositPaidAt,
          hasRemovalAppt: !!row.apptStartsAt,
          apptDayUk: row.apptStartsAt ? ukDayOf(row.apptStartsAt) : null,
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

  const by = (b: BookingBucket) => rows.filter((r) => r.bucket === b);
  const awaiting = by("deposit_outstanding").sort((a, b) => (a.acceptedAt ?? "").localeCompare(b.acceptedAt ?? ""));
  const noDate = by("no_date").sort((a, b) => (a.depositPaidAt ?? "").localeCompare(b.depositPaidAt ?? ""));
  const provisional = by("provisional").sort((a, b) =>
    (a.provisionalDate ?? a.approxMonth ?? "9999").localeCompare(b.provisionalDate ?? b.approxMonth ?? "9999"),
  );
  const byMoveDay = (a: Row, b: Row) => (a.apptStartsAt ?? "").localeCompare(b.apptStartsAt ?? "");
  const commitmentOverdue = by("commitment_overdue").sort(byMoveDay);
  const commitmentDue = by("commitment_due").sort(byMoveDay);
  const balanceOverdue = by("balance_overdue").sort(byMoveDay);
  const balanceDueRows = by("balance_due").sort(byMoveDay);
  const allSet = by("all_set").sort(byMoveDay);

  const commitmentToCollect = commitmentOverdue.concat(commitmentDue).reduce((s, r) => s + r.commitmentInvoiceAmount, 0);
  const balanceOutstanding = rows
    .filter((r) => r.depositPaidAt && !r.balancePaidAt)
    .reduce((s, r) => s + r.balanceAmount, 0);
  const needsCrew = (r: Row) =>
    !!r.apptStartsAt && r.crewAssigned === 0 && daysBetweenUk(todayUk, ukDayOf(r.apptStartsAt)) >= 0;
  const toAllocate = rows.filter(needsCrew);

  /* ---------- shared row fragments ---------- */

  const nameAndRef = (r: Row, detail: string) => (
    <div className="min-w-0 flex-1">
      <Link href={`/leads/${r.leadId}`} className="font-medium text-foreground hover:underline">
        {r.customer}
      </Link>
      <p className="text-xs text-mist-400">{detail}</p>
    </div>
  );

  const policyStrip = (r: Row) => (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <DateConfirmStatus
        leadId={r.leadId}
        state={{
          dateConfirmedAt: r.dateConfirmedAt,
          movingDate: r.quoteMovingDate,
          moveDateLabel: moveDateLabel(r.quoteMovingDate),
          depositPaidAt: r.depositPaidAt,
        }}
      />
      {r.apptId && r.apptStartsAt && r.apptEndsAt ? (
        <ChangeDateButton appointmentId={r.apptId} leadId={r.leadId} startsAt={r.apptStartsAt} endsAt={r.apptEndsAt} />
      ) : null}
      <CancelBookingButton leadId={r.leadId} />
    </div>
  );

  const windowButton = (r: Row, label: string) => (
    <BookingDetailsButton
      leadId={r.leadId}
      leadName={r.customer}
      label={label}
      initial={{
        approxWindow: r.approxWindow,
        approxMonth: r.approxMonth,
        provisionalDate: r.provisionalDate,
        propertyType: r.propertyType,
      }}
      context={{ depositPaid: true, commitmentPaid: !!r.commitmentPaidAt }}
    />
  );

  const bookLink = (r: Row) => (
    <Link
      href={`/schedule/removals?leadId=${r.leadId}`}
      className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3.5 text-sm font-semibold text-white transition-colors hover:brightness-95"
    >
      <CalendarPlus className="size-4" strokeWidth={2} />
      Book removal
    </Link>
  );

  const moveIn = (r: Row) => {
    const days = r.apptStartsAt ? daysBetweenUk(todayUk, ukDayOf(r.apptStartsAt)) : null;
    return days === null ? "" : days === 0 ? " (today)" : days > 0 ? ` (in ${days}d)` : ` (${-days}d ago)`;
  };

  const commitmentRow = (r: Row, overdue: boolean) => (
    <div key={r.quoteId} className="px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {nameAndRef(r, `${r.quoteRef} · ${gbp(r.agreed)} · moving ${dateLabel(r.apptStartsAt)}${moveIn(r)}`)}
        {r.dateReleasableAt ? (
          <span className="inline-flex items-center gap-1 rounded-pill bg-danger-bg px-2.5 py-1 text-xs font-bold text-danger">
            <AlertTriangle className="size-3.5" strokeWidth={2} /> DATE AT RISK
          </span>
        ) : overdue ? (
          <span className="inline-flex items-center gap-1 rounded-pill bg-danger-bg px-2.5 py-1 text-xs font-bold text-danger">
            <AlertTriangle className="size-3.5" strokeWidth={2} /> OVERDUE
          </span>
        ) : null}
        <span className={`rounded-pill px-2.5 py-1 text-xs font-semibold ${overdue ? "bg-danger-bg text-danger" : "bg-warn-bg text-warn"}`}>
          25% · {gbp(r.commitmentInvoiceAmount)}
          {r.commitmentDueDate ? ` due ${dateLabel(r.commitmentDueDate)}` : ""}
        </span>
        {needsCrew(r) ? <AllocateChip day={ukDayOf(r.apptStartsAt!)} /> : null}
        <Link
          href={`/leads/${r.leadId}`}
          className="focus-ring inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          Open lead
        </Link>
      </div>
      {policyStrip(r)}
    </div>
  );

  const balanceRow = (r: Row, overdue: boolean) => (
    <div key={r.quoteId} className="px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {nameAndRef(
          r,
          `${r.quoteRef} · ${gbp(r.agreed)} · ${overdue ? "moved" : "moving"} ${dateLabel(r.apptStartsAt)}${moveIn(r)}`,
        )}
        {overdue ? (
          <span className="inline-flex items-center gap-1 rounded-pill bg-danger-bg px-2.5 py-1 text-xs font-bold text-danger">
            <AlertTriangle className="size-3.5" strokeWidth={2} /> OVERDUE
          </span>
        ) : null}
        {needsCrew(r) ? <AllocateChip day={ukDayOf(r.apptStartsAt!)} /> : null}
        {r.balanceInvoiceNumber ? (
          <>
            <span className="rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">
              {r.balanceInvoiceNumber} · {gbp(r.balanceAmount)} due
            </span>
            <MarkPaidButton quoteId={r.quoteId} kind="balance" amount={r.balanceAmount} customerName={r.customer} />
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">
              <AlertTriangle className="size-3.5" strokeWidth={2} />
              {overdue ? `${gbp(r.balanceAmount)} unpaid` : "Invoice before move day"}
            </span>
            <BalanceInvoiceButton leadId={r.leadId} />
          </>
        )}
      </div>
      {policyStrip(r)}
    </div>
  );

  return (
    <main className="flex-1 space-y-5 p-6 md:p-8">
      <PageHeader eyebrow="Sales" title="Bookings">
        <p className="text-sm text-mist-400">The money queue — accepted quotes, from deposit to move day</p>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="£100 outstanding"
          value={gbp(awaiting.reduce((s, r) => s + r.deposit, 0))}
          sub={`${awaiting.length} job${awaiting.length === 1 ? "" : "s"} · auto-chased day 1 and 3`}
        />
        <Stat
          label="25% to collect"
          value={gbp(commitmentToCollect)}
          sub={
            commitmentOverdue.length
              ? `${commitmentOverdue.length} overdue · chased at T-10`
              : `${commitmentDue.length} invoiced · chased at T-10`
          }
        />
        <Stat label="Balance outstanding" value={gbp(balanceOutstanding)} sub="due in full before move day" />
        <Stat
          label="To allocate"
          value={String(toAllocate.length)}
          sub="confirmed, no crew yet"
          href="/schedule?tab=alloc"
        />
      </div>

      {/* ---------------- £100 outstanding ---------------- */}
      <Section
        title="£100 outstanding"
        hint="accepted online — locks in when the deposit lands"
        count={awaiting.length}
      >
        {awaiting.map((r) => (
          <div key={r.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
            {nameAndRef(
              r,
              `${r.quoteRef} · agreed ${gbp(r.agreed)} · accepted ${daysAgo(r.acceptedAt)}`,
            )}
            {r.chasePaused ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-warn">
                <PauseCircle className="size-3.5" strokeWidth={2} /> chasing paused
              </span>
            ) : r.depositChaseStep > 0 ? (
              <span className="text-xs text-mist-400">reminder {r.depositChaseStep}/2 sent</span>
            ) : null}
            {r.depositSelfreportAt ? (
              <span className="inline-flex items-center gap-1 rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">
                <AlertTriangle className="size-3.5" strokeWidth={2} /> Customer says sent — check the bank
              </span>
            ) : null}
            {r.cardStatus === "pending" ? (
              <span className="rounded-pill bg-mist-100 px-2.5 py-1 text-xs font-medium text-mist-500">
                Card started
              </span>
            ) : r.cardStatus === "failed" ? (
              <span className="rounded-pill bg-warn-bg px-2.5 py-1 text-xs font-medium text-warn">
                Card declined
              </span>
            ) : null}
            <span className="tabular text-sm font-semibold text-foreground">{gbp(r.deposit)}</span>
            {r.acceptToken ? <CopyLinkButton url={acceptUrlFor(r.acceptToken)} /> : null}
            <MarkPaidButton
              quoteId={r.quoteId}
              kind="deposit"
              amount={r.deposit}
              customerName={r.customer}
              leadId={r.leadId}
              moveDay={r.apptStartsAt ? ukDayOf(r.apptStartsAt) : null}
            />
          </div>
        ))}
      </Section>

      {/* ---------------- on the list, no date ---------------- */}
      <Section
        title="On the list — no date"
        hint="deposit paid, nothing pencilled — capture their window"
        count={noDate.length}
      >
        {noDate.map((r) => (
          <div key={r.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
            {nameAndRef(r, `${r.quoteRef} · ${gbp(r.agreed)} · deposit paid ${daysAgo(r.depositPaidAt)}`)}
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
              <CheckCircle2 className="size-3.5" strokeWidth={2} /> Deposit
            </span>
            {windowButton(r, "Set window")}
            {bookLink(r)}
          </div>
        ))}
      </Section>

      {/* ---------------- provisional ---------------- */}
      <Section
        title="Provisional"
        hint="window pencilled — the 25% is what reserves a date"
        count={provisional.length}
      >
        {provisional.map((r) => {
          const pencil = [
            r.provisionalDate ? `pencilled ${dateLabel(r.provisionalDate)}` : null,
            !r.provisionalDate && r.approxMonth ? `thinking ${dateLabel(r.approxMonth)?.replace(/^\w+ \d+ /, "") ?? ""}`.trim() : null,
            r.approxWindow ? `"${r.approxWindow}"` : null,
            r.propertyType === "homeowner" ? "homeowner — date will be fixed" : r.propertyType === "rented" ? "rented — flexible" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={r.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
              {nameAndRef(r, `${r.quoteRef} · ${gbp(r.agreed)} · ${pencil}`)}
              {windowButton(r, "Move window")}
              {bookLink(r)}
            </div>
          );
        })}
      </Section>

      {/* ---------------- 25% overdue / at risk ---------------- */}
      <Section
        title="25% overdue"
        hint="past due or date at risk — call them today"
        count={commitmentOverdue.length}
        tone="danger"
      >
        {commitmentOverdue.map((r) => commitmentRow(r, true))}
      </Section>

      {/* ---------------- 25% to collect ---------------- */}
      <Section
        title="25% to collect"
        hint="invoiced at date confirmation — auto-chased at T-10"
        count={commitmentDue.length}
      >
        {commitmentDue.map((r) => commitmentRow(r, false))}
      </Section>

      {/* ---------------- balance overdue ---------------- */}
      <Section
        title="Balance overdue"
        hint="moved with money outstanding — chase it now"
        count={balanceOverdue.length}
        tone="danger"
      >
        {balanceOverdue.map((r) => balanceRow(r, true))}
      </Section>

      {/* ---------------- balance to collect ---------------- */}
      <Section
        title="Balance to collect"
        hint="payment in full is due before move day"
        count={balanceDueRows.length}
      >
        {balanceDueRows.map((r) => balanceRow(r, false))}
      </Section>

      {/* ---------------- booked, all set ---------------- */}
      <Section title="Booked — all set" hint="nothing owed right now" count={allSet.length}>
        {allSet.map((r) => (
          <div key={r.quoteId} className="px-5 py-3.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {nameAndRef(r, `${r.quoteRef} · ${gbp(r.agreed)} · moving ${dateLabel(r.apptStartsAt)}${moveIn(r)}`)}
              {needsCrew(r) ? <AllocateChip day={ukDayOf(r.apptStartsAt!)} /> : null}
              {r.balancePaidAt ? (
                <span className="inline-flex items-center gap-1 rounded-pill bg-success-bg px-2.5 py-1 text-xs font-semibold text-success">
                  <CheckCircle2 className="size-3.5" strokeWidth={2} /> Paid in full
                </span>
              ) : (
                <span className="text-xs text-mist-400">{gbp(r.balanceAmount)} to invoice nearer the day</span>
              )}
            </div>
            {policyStrip(r)}
          </div>
        ))}
      </Section>
    </main>
  );
}
