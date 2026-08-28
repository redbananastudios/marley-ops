import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { loadBookingRows, ukDayOfInstant, type BookingRow } from "@/lib/bookings/load-signals";
import { daysBetweenUk, queueMoney } from "@/lib/bookings/queue";
import {
  groupMoneySections,
  sectionAmount,
  sectionTotal,
  type MoneySectionId,
} from "@/lib/bookings/sections";
import { applyBrandFilter } from "@/lib/brand-filter";
import { Card } from "@/components/ui/card";
import { poundsMoney, shortDate } from "./format";

/**
 * Due — what customers owe RIGHT NOW, with real £ totals per lifecycle stage.
 * Same rows, same classifier and the same per-obligation money seam as
 * /bookings (queueMoney + lib/bookings/sections) — this one is the admin money
 * read, Bookings stays the office action queue.
 *
 * Every section here prints its own total, which invites the reader to add
 * them up, so they MUST reach the headline above. They do, by construction:
 * membership is per obligation (lib/bookings/sections.ts), so the six owed
 * sections partition `owedNow` exactly and the three danger sections partition
 * `overdue`. They previously partitioned neither — sections were filtered by
 * BUCKET while the headline counted every obligation, so a gate 9b late
 * booking (balance invoiced at acceptance, deposit unpaid, slot not yet in the
 * diary) put £1,700 in "Owed right now" and in no list on the page.
 *
 * What the shared seam does and does not promise: both pages compute every
 * figure from the SAME rows and the SAME obligations, so no figure here can
 * contradict one there. It does NOT mean any single headline equals any
 * single tile — this page's "Owed right now" is 25% + balance together,
 * while /bookings decomposes the same money into one tile per rung. A QA
 * ledger entry once recorded "/bookings Balance outstanding matches
 * /payments Due exactly" as an invariant; it only ever held on a day with no
 * unpaid 25% (QA-20260826-01). Tile2 + tile3 is the identity that holds.
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
  section,
  tone,
  detail,
}: {
  title: string;
  hint: string;
  rows: BookingRow[];
  /** Which obligation this list is about — it decides the £ on every row. */
  section: MoneySectionId;
  tone?: "danger";
  detail: (r: BookingRow) => string;
}) {
  // An empty routine section is a one-line all-clear; an empty DANGER section
  // disappears (a red header with "all clear" cries wolf) — /bookings rule.
  // Safe only because the danger sections between them hold every penny of
  // the Overdue tile: a red headline can no longer point at nothing.
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
        <span className="tabular text-sm font-bold text-foreground">{poundsMoney(sectionTotal(rows, section))}</span>
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
                {poundsMoney(sectionAmount(r, section))}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export async function DueTab({ brandFilter = "all" }: { brandFilter?: string }) {
  const sb = await createClient();
  const { rows: allRows, todayUk } = await loadBookingRows(sb);

  // Brand narrowing (multi-brand PRD §4 Payments): loadBookingRows is shared
  // verbatim with /bookings, so the ?brand= filter rides a supplementary
  // CHUNKED fail-loud leads read (the /bookings precedent — PostgREST caps
  // unpaged reads at 1000 and a silent cap here would DROP rows and understate
  // the money tiles), with the narrowing applied IN THE DB on that read. At
  // 'all' (including single-brand mode) nothing runs and the tab is unchanged.
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
      if (leadErr) throw new Error(`payments due: brand read failed: ${leadErr.message}`);
      for (const l of leadRows ?? []) brandLeads.add(l.id);
    }
    rows = allRows.filter((r) => brandLeads.has(r.leadId));
  }

  // Lists and headline come off ONE seam: `groupMoneySections` places a row in
  // every section it owes money in, `queueMoney` totals the same obligations.
  // Neither can move without the other.
  const byMoveDay = (a: BookingRow, b: BookingRow) => (a.apptStartsAt ?? "").localeCompare(b.apptStartsAt ?? "");
  const s = groupMoneySections(rows);
  const deposits = s.deposits_outstanding.sort((a, b) => (a.acceptedAt ?? "").localeCompare(b.acceptedAt ?? ""));
  const commitmentOverdue = s.commitment_overdue.sort(byMoveDay);
  const commitmentDue = s.commitment_due.sort(byMoveDay);
  const balanceOverdue = s.balance_overdue.sort(byMoveDay);
  const balanceDueRows = s.balance_due.sort(byMoveDay);
  const commercialOverdue = s.commercial_overdue.sort(byMoveDay);
  const commercialDue = s.commercial_due.sort(byMoveDay);
  const commercialUndated = s.commercial_terms_unknown.sort(byMoveDay);

  // Headline money is computed per OBLIGATION, not per bucket, so a job whose
  // deposit is unpaid can still show the balance it owes this week — and the
  // £100 deposits are excluded entirely, because a deposit secures a booking
  // rather than falling due today (Peter, 2026-08-20). The deposits queue
  // below is unchanged; it just no longer inflates the headline.
  const money = queueMoney(rows);
  const overdueTotal = money.overdue;
  const dueTotal = money.owedNow - overdueTotal;

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
  // A balance can now be listed before the slot is allocated (gates 9b/9c
  // raise it at acceptance), so the move-day clause has to survive there
  // rather than printing "moving —".
  const movingLine = (r: BookingRow, verb: string): string =>
    r.apptStartsAt ? `${verb} ${shortDate(ukDayOfInstant(r.apptStartsAt))}${moveIn(r)}` : "no move date yet";

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
        section="balance_overdue"
        tone="danger"
        detail={(r) =>
          `${r.quoteRef} · ${r.balanceInvoiceNumber ?? "not invoiced"} · ${movingLine(r, "moved")}`
        }
      />
      <Section
        title="25% overdue"
        hint="past due or date at risk"
        rows={commitmentOverdue}
        section="commitment_overdue"
        tone="danger"
        detail={(r) => `${r.quoteRef} · due ${r.commitmentDueDate ? shortDate(r.commitmentDueDate) : "—"}`}
      />
      {/* Commercial money reached the headline from gate 10 with no list to
          hold it, so the Overdue tile could go red pointing at nothing. It
          keeps its own pair of sections rather than joining the residential
          ones: past its terms this is our own credit control, and a commercial
          client is never chased by email (PRD §3.10). */}
      <Section
        title="Commercial overdue"
        hint="past the client's terms — our credit control, never an email chase"
        rows={commercialOverdue}
        section="commercial_overdue"
        tone="danger"
        detail={(r) =>
          `${r.quoteRef} · ${r.balanceInvoiceNumber ?? "not invoiced"} · terms ${r.commercialDueDate ? shortDate(r.commercialDueDate) : "—"}`
        }
      />
      <Section
        title="Deposits outstanding"
        hint="accepted online, deposit unpaid — auto-chased day 1 and 3"
        rows={deposits}
        section="deposits_outstanding"
        detail={(r) => `${r.quoteRef} · agreed ${poundsMoney(r.agreed)} · accepted ${daysAgo(r.acceptedAt)}`}
      />
      <Section
        title="25% to collect"
        hint="invoiced at date confirmation — auto-chased at T-10"
        rows={commitmentDue}
        section="commitment_due"
        detail={(r) => `${r.quoteRef} · due ${r.commitmentDueDate ? shortDate(r.commitmentDueDate) : "—"}`}
      />
      <Section
        title="Balance to collect"
        hint="payment in full is due before move day"
        rows={balanceDueRows}
        section="balance_due"
        detail={(r) =>
          `${r.quoteRef} · ${r.balanceInvoiceNumber ?? "invoice before move day"} · ${movingLine(r, "moving")}`
        }
      />
      {/* Hidden when empty, like its danger twin and like /bookings: with no
          commercial clients this tab reads exactly as it did before gate 10.
          An absent section still holds £0, so the arithmetic is untouched. */}
      {/* Invoiced with NO terms date: whether it is late is unknown, not
          answered. It sits apart from "Commercial invoiced" for the same
          reason it has its own bucket — reading a missing date as "in terms"
          is the reassuring answer produced by having no information at all.
          Not a danger section: overdue is a claim of fact about a date, and
          there is no date here to make it about. */}
      {commercialUndated.length ? (
        <Section
          title="Commercial — no terms date"
          hint="invoiced, but nothing says when it falls due — check the invoice"
          rows={commercialUndated}
          section="commercial_terms_unknown"
          detail={(r) => `${r.quoteRef} · ${r.balanceInvoiceNumber ?? "not invoiced"} · terms date missing`}
        />
      ) : null}

      {commercialDue.length ? (
        <Section
          title="Commercial invoiced"
          hint="completion invoice raised, inside the client's terms"
          rows={commercialDue}
          section="commercial_due"
          detail={(r) =>
            `${r.quoteRef} · ${r.balanceInvoiceNumber ?? "not invoiced"} · terms ${r.commercialDueDate ? shortDate(r.commercialDueDate) : "—"}`
          }
        />
      ) : null}

      <p className="text-xs text-mist-400">
        Every section above adds up to <span className="font-medium text-foreground">Owed right now</span> — a job
        owing the 25% and a balance at once appears in both, for its own share of each. Deposits sit outside that
        total. Same rows as{" "}
        <Link href="/bookings" className="font-medium text-mm-red hover:underline">
          Bookings
        </Link>{" "}
        — that page carries the actions (mark paid, invoice, chase); this one is the money read.
      </p>
    </>
  );
}
