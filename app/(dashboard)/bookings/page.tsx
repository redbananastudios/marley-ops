import Link from "next/link";
import { AlertTriangle, CalendarPlus, CheckCircle2, PauseCircle, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { acceptUrlFor } from "@/lib/quote/accept-flow";
import { moveDateLabel } from "@/lib/quote/payments";
import { daysBetweenUk, type BookingBucket } from "@/lib/bookings/queue";
import { loadBookingRows, ukDayOfInstant as ukDayOf, type BookingRow as Row } from "@/lib/bookings/load-signals";
import { windowTierLabel } from "@/lib/bookings/booking-details";
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
  // UK wall-clock, like ukDayOf above. The container runs UTC, so without this an
  // all-day BST move (stored 23:00Z the previous day) printed the WRONG weekday
  // and date — and contradicted the "(in Nd)" on the same row, which does use UK
  // time. Safe for the yyyy-mm-dd callers too: they are parsed at local midnight.
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
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
  // Shared with the /payments Due + Upcoming tabs — one ledger, one classifier.
  const { rows, todayUk } = await loadBookingRows(sb);

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
      {r.legacy ? (
        <span
          className="ml-2 inline-flex items-center rounded-pill bg-muted px-2 py-0.5 align-middle text-[11px] font-semibold text-mist-500"
          title="Imported from iMVE — old-terms booking, payments handled manually"
        >
          Legacy (iMVE)
        </span>
      ) : null}
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
            !r.provisionalDate && (r.approxMonth || r.approxWindow)
              ? `thinking ${windowTierLabel(r.approxWindow, r.approxMonth) ?? ""}`.trim()
              : null,
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
