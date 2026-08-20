import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { loadBookingRows, ukDayOfInstant, type BookingRow } from "@/lib/bookings/load-signals";
import { daysBetweenUk, type BookingBucket } from "@/lib/bookings/queue";
import { Card } from "@/components/ui/card";
import { poundsMoney, shortDate } from "./format";

/**
 * Due — what customers owe RIGHT NOW, with real £ totals per lifecycle stage.
 * Same rows and classifier as /bookings (lib/bookings/load-signals), so the
 * two surfaces can never disagree; this one is the admin money read, Bookings
 * stays the office action queue.
 */

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "danger" }) {
  return (
    <Card className="px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p
        className={`tabular mt-1 font-display text-2xl font-bold ${tone === "danger" ? "text-danger" : "text-foreground"}`}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </Card>
  );
}

function Section({
  title,
  hint,
  rows,
  total,
  tone,
  detail,
}: {
  title: string;
  hint: string;
  rows: BookingRow[];
  total: number;
  tone?: "danger";
  detail: (r: BookingRow) => string;
}) {
  // An empty routine section is a one-line all-clear; an empty DANGER section
  // disappears (a red header with "all clear" cries wolf) — /bookings rule.
  if (rows.length === 0 && tone === "danger") return null;
  return (
    <Card className="p-0">
      <div
        className={`flex items-baseline gap-3 border-b px-5 py-3.5 ${tone === "danger" ? "border-danger-border bg-danger-bg/40" : ""}`}
      >
        <h2 className={`font-display text-lg ${tone === "danger" ? "text-danger" : "text-foreground"}`}>{title}</h2>
        <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
          {rows.length}
        </span>
        <span className="ml-auto hidden text-xs text-mist-400 sm:block">{hint}</span>
        <span className="tabular text-sm font-bold text-foreground">{poundsMoney(total)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-mist-400">Nothing here — all clear.</p>
      ) : (
        <div className="divide-y divide-mist-150">
          {rows.map((r) => (
            <div key={r.quoteId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
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
                <p className="text-xs text-mist-400">{detail(r)}</p>
              </div>
              {tone === "danger" ? (
                <span className="inline-flex items-center gap-1 rounded-pill bg-danger-bg px-2.5 py-1 text-xs font-bold text-danger">
                  <AlertTriangle className="size-3.5" strokeWidth={2} /> OVERDUE
                </span>
              ) : null}
              <span className="tabular text-sm font-semibold text-foreground">
                {poundsMoney(sectionAmount(r))}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** The £ a row owes in ITS section — deposit for the deposit queue, the 25%
 *  for commitment queues, the balance for balance queues. */
function sectionAmount(r: BookingRow): number {
  if (r.bucket === "deposit_outstanding") return r.deposit;
  if (r.bucket === "commitment_due" || r.bucket === "commitment_overdue") return r.commitmentInvoiceAmount;
  return r.balanceAmount;
}

export async function DueTab() {
  const sb = await createClient();
  const { rows, todayUk } = await loadBookingRows(sb);

  const by = (b: BookingBucket) => rows.filter((r) => r.bucket === b);
  const sum = (rs: BookingRow[]) => rs.reduce((s, r) => s + sectionAmount(r), 0);

  const deposits = by("deposit_outstanding").sort((a, b) => (a.acceptedAt ?? "").localeCompare(b.acceptedAt ?? ""));
  const byMoveDay = (a: BookingRow, b: BookingRow) => (a.apptStartsAt ?? "").localeCompare(b.apptStartsAt ?? "");
  const commitmentOverdue = by("commitment_overdue").sort(byMoveDay);
  const commitmentDue = by("commitment_due").sort(byMoveDay);
  const balanceOverdue = by("balance_overdue").sort(byMoveDay);
  const balanceDueRows = by("balance_due").sort(byMoveDay);

  // Headline money is computed per OBLIGATION, not per bucket, so a job whose
  // deposit is unpaid can still show the balance it owes this week — and the
  // £100 deposits are excluded entirely, because a deposit secures a booking
  // rather than falling due today (Peter, 2026-08-20). The deposits queue
  // below is unchanged; it just no longer inflates the headline.
  const overdueTotal = rows.reduce((s, r) => s + r.owed.overdue, 0);
  const dueTotal = rows.reduce((s, r) => s + r.owed.total, 0) - overdueTotal;

  const moveIn = (r: BookingRow): string => {
    if (!r.apptStartsAt) return "";
    const days = daysBetweenUk(todayUk, ukDayOfInstant(r.apptStartsAt));
    return days === 0 ? " (today)" : days > 0 ? ` (in ${days}d)` : ` (${-days}d ago)`;
  };
  const daysAgo = (iso: string | null): string => {
    if (!iso) return "";
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Owed right now"
          value={poundsMoney(overdueTotal + dueTotal)}
          sub="invoiced 25% + balances due (deposits excluded)"
        />
        <Stat
          label="Overdue"
          value={poundsMoney(overdueTotal)}
          sub="past due — chase today"
          tone={overdueTotal > 0 ? "danger" : undefined}
        />
        <Stat label="Due" value={poundsMoney(dueTotal)} sub="inside its window" />
      </div>

      <Section
        title="Balance overdue"
        hint="moved with money outstanding"
        rows={balanceOverdue}
        total={sum(balanceOverdue)}
        tone="danger"
        detail={(r) =>
          `${r.quoteRef} · ${r.balanceInvoiceNumber ?? "not invoiced"} · moved ${r.apptStartsAt ? shortDate(ukDayOfInstant(r.apptStartsAt)) : "—"}${moveIn(r)}`
        }
      />
      <Section
        title="25% overdue"
        hint="past due or date at risk"
        rows={commitmentOverdue}
        total={sum(commitmentOverdue)}
        tone="danger"
        detail={(r) => `${r.quoteRef} · due ${r.commitmentDueDate ? shortDate(r.commitmentDueDate) : "—"}`}
      />
      <Section
        title="Deposits outstanding"
        hint="accepted online, £100 unpaid — auto-chased day 1 and 3"
        rows={deposits}
        total={sum(deposits)}
        detail={(r) => `${r.quoteRef} · agreed ${poundsMoney(r.agreed)} · accepted ${daysAgo(r.acceptedAt)}`}
      />
      <Section
        title="25% to collect"
        hint="invoiced at date confirmation — auto-chased at T-10"
        rows={commitmentDue}
        total={sum(commitmentDue)}
        detail={(r) => `${r.quoteRef} · due ${r.commitmentDueDate ? shortDate(r.commitmentDueDate) : "—"}`}
      />
      <Section
        title="Balance to collect"
        hint="payment in full is due before move day"
        rows={balanceDueRows}
        total={sum(balanceDueRows)}
        detail={(r) =>
          `${r.quoteRef} · ${r.balanceInvoiceNumber ?? "invoice before move day"} · moving ${r.apptStartsAt ? shortDate(ukDayOfInstant(r.apptStartsAt)) : "—"}${moveIn(r)}`
        }
      />

      <p className="text-xs text-mist-400">
        Same rows as <Link href="/bookings" className="font-medium text-mm-red hover:underline">Bookings</Link> — that
        page carries the actions (mark paid, invoice, chase); this one is the money read.
      </p>
    </>
  );
}
