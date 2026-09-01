import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { loadBookingRows, ukDayOfInstant } from "@/lib/bookings/load-signals";
import { buildUpcoming, type UpcomingSignal } from "@/lib/payments/upcoming";
import { applyBrandFilter } from "@/lib/brand-filter";
import { Card } from "@/components/ui/card";
import { poundsMoney, shortDate } from "./format";

/**
 * Upcoming — expected money over the next four Mon–Sun weeks (Peter,
 * 2026-08-16), from dates we actually hold: 25% invoice due dates and booked
 * move days (payment in full lands by move day; the T-7 cron raises the final
 * invoice inside that window). Deposit-paid bookings with no committed date
 * sit in the pencilled pipeline underneath — real money, no date to put it on.
 *
 * Commercial money is dated by the CLIENT'S TERMS instead (PRD §3.10) — 30 or
 * 60 days after the job completes, never the move day. `buildUpcoming` owns
 * that split; this file only has to render its two extra shapes. The undated
 * commercial card is hidden when empty, like the commercial sections on the
 * Due tab: with no commercial clients this tab reads exactly as it did before.
 */

const KIND_CHIP: Record<string, { label: string; cls: string }> = {
  commitment: { label: "25%", cls: "bg-warn-bg text-warn" },
  balance: { label: "Balance", cls: "bg-info-bg text-info" },
  commercial: { label: "Commercial", cls: "bg-muted text-mist-500" },
};

/** The line under a customer's name, per ladder. Commercial does NOT say "due
 *  in full by move day": that sentence is true of the residential balance and
 *  false of a completion invoice with a month of terms still to run. */
const KIND_CAPTION: Record<string, string> = {
  commitment: " · 25% invoice due",
  balance: " · due in full by move day",
  commercial: " · due on the client's agreed terms",
};

function weekLabel(startDay: string, endDay: string, todayUk: string): string {
  const label = `${shortDate(startDay)} – ${shortDate(endDay)}`;
  return startDay <= todayUk && todayUk <= endDay ? `This week · ${label}` : label;
}

export async function UpcomingTab({ brandFilter = "all" }: { brandFilter?: string }) {
  const sb = await createClient();
  const { rows: allRows, todayUk } = await loadBookingRows(sb);

  // Brand narrowing (multi-brand PRD §4 Payments): loadBookingRows is shared
  // verbatim with /bookings, so the ?brand= filter rides a supplementary
  // CHUNKED fail-loud leads read (the /bookings precedent — a silent cap or
  // failed read would DROP rows and understate expected money), narrowed IN
  // THE DB on that read. At 'all' (including single-brand mode) nothing runs
  // and the tab is unchanged.
  let rows = allRows;
  if (brandFilter !== "all" && allRows.length) {
    const leadIds = [...new Set(allRows.map((r) => r.leadId))];
    const brandLeads = new Set<string>();
    // 100-id batches: PostgREST .in() rides the GET query string and the
    // gateway 414s past ~200 UUIDs (lib/bank-feed/sync.ts measured the limit).
    for (let i = 0; i < leadIds.length; i += 100) {
      const { data: leadRows, error: leadErr } = await applyBrandFilter(
        sb.from("leads").select("id").in("id", leadIds.slice(i, i + 100)),
        brandFilter,
      );
      if (leadErr) throw new Error(`payments upcoming: brand read failed: ${leadErr.message}`);
      for (const l of leadRows ?? []) brandLeads.add(l.id);
    }
    rows = allRows.filter((r) => brandLeads.has(r.leadId));
  }

  const signals: UpcomingSignal[] = rows.map((r) => ({
    quoteId: r.quoteId,
    quoteRef: r.quoteRef,
    leadId: r.leadId,
    customer: r.customer,
    bucket: r.bucket,
    legacy: r.legacy,
    // The two fields that keep a commercial row off the residential schedule.
    // Drop either and every commercial booking silently re-reads as
    // residential — dated on its move day and OVERDUE the morning after —
    // with every unit test still green, because they hand `buildUpcoming` its
    // input directly. A source-shape test pins this projection for that reason.
    paymentPolicy: r.paymentPolicy,
    commercialDueDate: r.commercialDueDate,
    commitmentInvoiceAmount: r.commitmentInvoiceAmount,
    commitmentPaidAt: r.commitmentPaidAt,
    commitmentDueDate: r.commitmentDueDate,
    balanceAmount: r.balanceAmount,
    balancePaidAt: r.balancePaidAt,
    moveDayUk: r.apptStartsAt ? ukDayOfInstant(r.apptStartsAt) : null,
    approxWindow: r.approxWindow,
    approxMonth: r.approxMonth,
    provisionalDate: r.provisionalDate,
  }));
  const view = buildUpcoming(signals, todayUk);
  const horizonTotal = view.weeks.reduce((s, w) => s + w.total, 0);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="px-5 py-4">
          <p className="eyebrow">Next 4 weeks</p>
          <p className="tabular mt-1 font-display text-2xl font-bold text-foreground">{poundsMoney(horizonTotal)}</p>
          <p className="mt-0.5 text-xs text-mist-400">
            {shortDate(view.horizonStart)} – {shortDate(view.horizonEnd)} · invoiced 25% + booked balances +
            commercial terms
          </p>
        </Card>
        <Card className="px-5 py-4">
          <p className="eyebrow">Beyond that</p>
          <p className="tabular mt-1 font-display text-2xl font-bold text-foreground">{poundsMoney(view.beyond.total)}</p>
          <p className="mt-0.5 text-xs text-mist-400">
            {view.beyond.count} booked job{view.beyond.count === 1 ? "" : "s"} past the horizon
          </p>
        </Card>
        <Card className="px-5 py-4">
          <p className="eyebrow">Pencilled pipeline</p>
          <p className="tabular mt-1 font-display text-2xl font-bold text-foreground">{poundsMoney(view.pencilled.total)}</p>
          <p className="mt-0.5 text-xs text-mist-400">deposit paid, date still to be committed</p>
        </Card>
      </div>

      {view.weeks.map((week) => (
        <Card key={week.startDay} className="p-0">
          <div className="flex items-baseline gap-3 border-b px-5 py-3.5">
            <CalendarClock className="size-4 self-center text-mist-400" strokeWidth={1.75} />
            <h2 className="font-display text-lg text-foreground">{weekLabel(week.startDay, week.endDay, todayUk)}</h2>
            <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
              {week.items.length}
            </span>
            <span className="ml-auto tabular text-sm font-bold text-foreground">{poundsMoney(week.total)}</span>
          </div>
          {week.items.length === 0 ? (
            <p className="px-5 py-4 text-sm text-mist-400">Nothing expected this week.</p>
          ) : (
            <div className="divide-y divide-mist-150">
              {week.items.map((item) => {
                const chip = KIND_CHIP[item.kind];
                return (
                  <div
                    key={`${item.quoteId}:${item.kind}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5"
                  >
                    <span className="tabular w-16 shrink-0 text-xs text-mist-400">{shortDate(item.dueDay)}</span>
                    <div className="min-w-0 flex-1">
                      <Link href={`/leads/${item.leadId}`} className="font-medium text-foreground hover:underline">
                        {item.customer}
                      </Link>
                      {item.legacy ? (
                        <span className="ml-2 inline-flex items-center rounded-pill bg-muted px-2 py-0.5 align-middle text-[11px] font-semibold text-mist-500">
                          Legacy (iMVE)
                        </span>
                      ) : null}
                      <p className="text-xs text-mist-400">
                        {item.quoteRef}
                        {KIND_CAPTION[item.kind] ?? ""}
                      </p>
                    </div>
                    {item.overdue ? (
                      <span className="rounded-pill bg-danger-bg px-2.5 py-0.5 text-[11px] font-bold text-danger">
                        OVERDUE
                      </span>
                    ) : null}
                    <span className={`rounded-pill px-2.5 py-0.5 text-[11px] font-semibold ${chip.cls}`}>
                      {chip.label}
                    </span>
                    <span className="tabular text-sm font-semibold text-foreground">{poundsMoney(item.amount)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ))}

      {/* Commercial money that has no terms date to place it on. Hidden when
          empty, like its Due-tab counterparts. It is a LIST rather than an
          omission because the alternative is this board reporting "nothing
          expected" about a live unpaid commercial invoice — the absence of a
          finding read as good news, which is the failure shape this codebase
          keeps hitting. The two reasons are printed per row: awaiting
          completion is the ordinary state of a booked job, while a raised
          invoice with no terms date is a defect NO overdue rule can ever
          catch, so it sorts first and carries a marker. */}
      {view.commercialUndated.items.length ? (
        <Card className="p-0">
          <div className="flex items-baseline gap-3 border-b px-5 py-3.5">
            <h2 className="font-display text-lg text-foreground">Commercial, not yet dated</h2>
            <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
              {view.commercialUndated.items.length}
            </span>
            <span className="ml-auto hidden text-xs text-mist-400 sm:block">
              invoiced on completion, then due on the client&rsquo;s terms
            </span>
            <span className="tabular text-sm font-bold text-foreground">
              {poundsMoney(view.commercialUndated.total)}
            </span>
          </div>
          <div className="divide-y divide-mist-150">
            {view.commercialUndated.items.map((item) => (
              <div key={item.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/leads/${item.leadId}`} className="font-medium text-foreground hover:underline">
                    {item.customer}
                  </Link>
                  {item.legacy ? (
                    <span className="ml-2 inline-flex items-center rounded-pill bg-muted px-2 py-0.5 align-middle text-[11px] font-semibold text-mist-500">
                      Legacy (iMVE)
                    </span>
                  ) : null}
                  <p className="text-xs text-mist-400">
                    {item.quoteRef} · {item.reason}
                  </p>
                </div>
                {item.needsAttention ? (
                  <span className="rounded-pill bg-warn-bg px-2.5 py-0.5 text-[11px] font-bold text-warn">
                    CHECK INVOICE
                  </span>
                ) : null}
                <span className="tabular text-sm font-semibold text-foreground">{poundsMoney(item.amount)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="p-0">
        <div className="flex items-baseline gap-3 border-b px-5 py-3.5">
          <h2 className="font-display text-lg text-foreground">Pencilled pipeline</h2>
          <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
            {view.pencilled.items.length}
          </span>
          <span className="ml-auto hidden text-xs text-mist-400 sm:block">
            deposit paid — capture or confirm the date to move it onto the board
          </span>
          <span className="tabular text-sm font-bold text-foreground">{poundsMoney(view.pencilled.total)}</span>
        </div>
        {view.pencilled.items.length === 0 ? (
          <p className="px-5 py-4 text-sm text-mist-400">Nothing pencilled — every paid booking has a date.</p>
        ) : (
          <div className="divide-y divide-mist-150">
            {view.pencilled.items.map((item) => (
              <div key={item.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <Link href={`/leads/${item.leadId}`} className="font-medium text-foreground hover:underline">
                    {item.customer}
                  </Link>
                  {item.legacy ? (
                    <span className="ml-2 inline-flex items-center rounded-pill bg-muted px-2 py-0.5 align-middle text-[11px] font-semibold text-mist-500">
                      Legacy (iMVE)
                    </span>
                  ) : null}
                  <p className="text-xs text-mist-400">
                    {item.quoteRef}
                    {item.windowLabel ? ` · ${item.windowLabel}` : " · no window captured yet"}
                  </p>
                </div>
                <span className="tabular text-sm font-semibold text-foreground">{poundsMoney(item.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
