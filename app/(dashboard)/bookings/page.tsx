import Link from "next/link";
import { AlertTriangle, CalendarPlus, CheckCircle2, PauseCircle, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { acceptUrlFor } from "@/lib/quote/accept-flow";
import { moveDateLabel } from "@/lib/quote/payments";
import { daysBetweenUk, queueMoney, type BookingBucket } from "@/lib/bookings/queue";
import { loadBookingRows, ukDayOfInstant as ukDayOf, type BookingRow as Row } from "@/lib/bookings/load-signals";
import { windowTierLabel } from "@/lib/bookings/booking-details";
import { DEFAULT_BRAND, listActiveBrands } from "@/lib/brand";
import { applyBrandFilter, parseBrandParam } from "@/lib/brand-filter";
import { PageHeader } from "@/components/page-header";
import { BrandChip } from "@/components/brand/brand-chip";
import { BrandFilter } from "@/components/brand/brand-filter";
import { Card } from "@/components/ui/card";
import { BalanceInvoiceButton } from "@/components/leads/balance-invoice-button";
import { SendPaymentLinkButton } from "@/components/leads/send-payment-link-button";
import { cardEnabledBrands } from "@/lib/payments/card-payments";
import { ResendInvoiceButton } from "@/components/leads/resend-invoice-button";
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

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const sb = await createClient();
  // Shared with the /payments Due + Upcoming tabs — one ledger, one classifier.
  const { rows: allRows, todayUk } = await loadBookingRows(sb);

  // Brand layer (multi-brand PRD §4 Bookings): with a single active brand no
  // brand UI renders and the page is unchanged (the single-brand invariant,
  // PRD §1). loadBookingRows is shared verbatim with /payments, so the brand
  // and import signals ride a supplementary batched read of the rows' leads
  // here rather than widening the shared loader; the ?brand= narrowing is
  // applied in the DB on that read, and the row set filters to its result —
  // so all 8 money-lifecycle sections, their count pills and the summary
  // tiles follow the filter.
  const activeBrands = await listActiveBrands(sb);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(await searchParams, activeBrands);

  const brandByLead = new Map<string, string>();
  const importedLeads = new Set<string>();
  if (multi && allRows.length) {
    const leadIds = [...new Set(allRows.map((r) => r.leadId))];
    // CHUNKED on purpose: PostgREST caps unpaged reads at 1000 rows, and this
    // is the one place where truncation would DROP rows rather than degrade
    // enrichment — a brand-filtered /bookings keeps only rows this read
    // returns, so a silent cap would understate the money tiles. 100 ids per
    // batch keeps the `in` filter inside the gateway's measured ~200-UUID/8KB
    // URL limit (lib/bank-feed/sync.ts chunks at 100 for the same reason).
    for (let i = 0; i < leadIds.length; i += 100) {
      const batch = leadIds.slice(i, i + 100);
      const { data: leadBrands, error: leadBrandsErr } = await applyBrandFilter(
        sb.from("leads").select("id, brand, source_system").in("id", batch),
        brandFilter,
      );
      // Fail loud, not narrow: a failed batch under a brand filter would
      // silently drop every booking in it (the "I could not check" rule).
      if (leadBrandsErr) throw new Error(`bookings brand read failed: ${leadBrandsErr.message}`);
      for (const l of leadBrands ?? []) {
        brandByLead.set(l.id, l.brand);
        // Imported bookings carry an "Imported" pill until the job completes —
        // same lifecycle as the legacy pill: completed leads never reach this
        // page (loadBookingRows drops them), so the pill retires with the row.
        if (l.source_system === "pitmans") importedLeads.add(l.id);
      }
    }
  }
  const rows =
    multi && brandFilter !== "all" ? allRows.filter((r) => brandByLead.has(r.leadId)) : allRows;

  // Chip data comes straight off the active-brand rows (server component — no
  // client payload to slim). Hidden when the segmented control already names
  // a single brand (multi-brand PRD §4 opening rules).
  const showBrandChips = multi && brandFilter === "all";
  const chipBySlug = new Map(activeBrands.map((b) => [b.slug, b]));

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

  // Both money tiles read the SAME per-obligation ledger as /payments. The 25%
  // tile used to sum the commitment_* BUCKETS, which the ladder only reaches
  // once the deposit is paid and a removal appointment exists — so an invoiced,
  // unpaid 25% on a booking whose slot is not in the diary yet read as £0 while
  // /payments counted it (QA-20260826-01). The balance tile had already been
  // fixed for the identical shape (QA-20260820-04); this puts both on one seam.
  const money = queueMoney(rows);
  // Gate 9d: resolved once for the page rather than per row, and by the one
  // helper that ANDs the global kill switch with each brand's own switch
  // (PRD §11.10). A brand with card off never renders the action, so the
  // word 'card' never reaches one of its surfaces.
  const cardBrands = await cardEnabledBrands(sb);
  const needsCrew = (r: Row) =>
    !!r.apptStartsAt && r.crewAssigned === 0 && daysBetweenUk(todayUk, ukDayOf(r.apptStartsAt)) >= 0;
  const toAllocate = rows.filter(needsCrew);

  /* ---------- shared row fragments ---------- */

  const nameAndRef = (r: Row, detail: string) => {
    // Brand chip — beside the customer name, in the pills' position; hidden
    // when the ?brand= filter already names one brand (multi-brand PRD §4).
    const chipBrand = showBrandChips ? chipBySlug.get(brandByLead.get(r.leadId) ?? "") : undefined;
    return (
      <div className="min-w-0 flex-1">
        <Link href={`/leads/${r.leadId}`} className="font-medium text-foreground hover:underline">
          {r.customer}
        </Link>
        {chipBrand ? <BrandChip brand={chipBrand} className="ml-2 align-middle" /> : null}
        {r.legacy ? (
          <span
            className="ml-2 inline-flex items-center rounded-pill bg-muted px-2 py-0.5 align-middle text-[11px] font-semibold text-mist-500"
            title="Imported from iMVE — old-terms booking, payments handled manually"
          >
            Legacy (iMVE)
          </span>
        ) : null}
        {importedLeads.has(r.leadId) ? (
          <span
            className="ml-2 inline-flex items-center rounded-pill bg-muted px-2 py-0.5 align-middle text-[11px] font-semibold text-mist-500"
            title="Imported booking — carried across mid-flight from the previous diary"
          >
            Imported
          </span>
        ) : null}
        <p className="text-xs text-mist-400">{detail}</p>
      </div>
    );
  };

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
        {/* Both 25% sections are "invoiced and unpaid" by definition, so the
            invoice can always usefully be sent again from here. */}
        <ResendInvoiceButton leadId={r.leadId} rail="commitment" />
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
            {/* Sending the invoice again belongs exactly here — the row that says
                it is raised and unpaid. Without it the office can only mark the
                money in, never ask for it a second time. */}
            <BalanceInvoiceButton leadId={r.leadId} />
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
        {/* Brand filter (multi-brand PRD §4 Bookings) — this page has no search
            bar, so the segmented control lives in the PageHeader. */}
        {multi ? (
          <BrandFilter
            brands={activeBrands.map((b) => ({ slug: b.slug, name: b.name, shortName: b.shortName }))}
          />
        ) : null}
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Deposits outstanding"
          value={gbp(money.depositsOutstanding)}
          sub={`${money.depositJobs} job${money.depositJobs === 1 ? "" : "s"} · auto-chased day 1 and 3`}
        />
        <Stat
          label="25% to collect"
          value={gbp(money.commitment)}
          sub={
            commitmentOverdue.length
              ? `${commitmentOverdue.length} overdue · ${money.commitmentJobs} invoiced · chased at T-10`
              : `${money.commitmentJobs} invoiced · chased at T-10`
          }
        />
        <Stat label="Balance to collect" value={gbp(money.balance)} sub="final balances only, not the 25%" />
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
            {/* This whole section IS "accepted, deposit unpaid", so the customer
                who says they never got the email can be sent it again from the
                row that names them — no hand-typed message, same figure, same
                link. Copying the link only helps if someone is on the phone. */}
            <ResendInvoiceButton leadId={r.leadId} rail="deposit" />
            {/* The customer who phones in unable to do a bank transfer: send
                them a card page instead of reading card details down the line.
                Only for a brand whose card channel is actually live. */}
            {cardBrands.has(brandByLead.get(r.leadId) ?? DEFAULT_BRAND) ? (
              <SendPaymentLinkButton
                quoteId={r.quoteId}
                amount={r.deposit}
                hasEmail={!!r.customerEmail}
                hasPhone={!!r.customerPhone}
              />
            ) : null}
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
