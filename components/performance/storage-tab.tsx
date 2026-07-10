import Link from "next/link";
import { Card } from "@/components/ui/card";
import { UNIT_TYPES } from "@/lib/storage-units";
import type { StorageBillingStats, StorageReport } from "@/lib/storage-report";

/**
 * Performance → Storage tab (iMVE Storage Analysis clone-and-improve; numbers
 * from lib/storage-report.ts). Same card language as the Sales tab: every KPI
 * prints its definition. Revenue figures come from AGREED LET RATES — storage
 * invoicing stays manual in Zoho until billing phase 2, and the cards say so.
 */

const gbp = (n: number): string =>
  "£" + Number(n).toFixed(2).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const TYPE_LABEL = Object.fromEntries(UNIT_TYPES.map((t) => [t.value, t.label]));

function KpiCard({ value, sub, label, definition }: { value: string; sub?: string; label: string; definition: string }) {
  return (
    <Card className="gap-1 p-5">
      <p className="eyebrow">{label}</p>
      <p className="font-display text-3xl font-bold tabular text-foreground">
        {value}
        {sub ? <span className="ml-2 align-middle font-sans text-sm font-normal text-mist-400">{sub}</span> : null}
      </p>
      <p className="text-xs leading-snug text-mist-400">{definition}</p>
    </Card>
  );
}

export interface CurrentLetRow {
  id: string;
  client_name: string;
  client_id: string;
  unit_label: string;
  site_name: string;
  start_date: string;
  rate: number | null;
  rate_period: string;
  weeks: number;
}

function fmtDate(d: string): string {
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return isNaN(t.getTime())
    ? "—"
    : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function StorageTab({
  report,
  currentLets,
  billing,
}: {
  report: StorageReport;
  currentLets: CurrentLetRow[];
  billing: StorageBillingStats;
}) {
  const r = report;
  const hasStorage = r.sites > 0 || r.units.total > 0;

  if (!hasStorage) {
    return (
      <Card className="p-0">
        <p className="px-5 py-12 text-center text-sm text-mist-400">
          No storage set up yet — add a site and its units on the{" "}
          <Link href="/storage" className="underline underline-offset-2">Storage page</Link> and the analysis appears
          here.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* occupancy */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Sites" value={String(r.sites)} definition="Active storage locations." />
        <Card className="gap-1 p-5">
          <p className="eyebrow">Occupancy</p>
          <p className="font-display text-3xl font-bold tabular text-foreground">
            {r.units.occupancyPct != null ? `${r.units.occupancyPct}%` : "—"}
            <span className="ml-2 align-middle font-sans text-sm font-normal text-mist-400">
              {r.units.occupied} of {r.units.total} units
            </span>
          </p>
          <div className="mt-1 h-2 overflow-hidden rounded-pill bg-mist-100">
            <div
              className="h-full rounded-pill bg-mm-red"
              style={{ width: `${r.units.occupancyPct ?? 0}%` }}
            />
          </div>
          <p className="text-xs leading-snug text-mist-400">Active units with a customer in them right now.</p>
        </Card>
        <KpiCard
          label="Available"
          value={String(r.units.available)}
          definition="Empty units ready to let — the sales team's headroom."
        />
        <KpiCard
          label="Storage customers"
          value={String(r.customers.current)}
          sub={r.customers.former ? `+ ${r.customers.former} past` : undefined}
          definition="Clients storing with us now; past = moved out."
        />
      </div>

      {/* revenue — from agreed rates, invoicing is manual in Zoho */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Recurring / week"
          value={gbp(r.recurring.perWeek)}
          sub={
            r.recurring.unpricedLets
              ? `${r.recurring.unpricedLets} let${r.recurring.unpricedLets === 1 ? "" : "s"} unpriced`
              : `${r.recurring.pricedLets} let${r.recurring.pricedLets === 1 ? "" : "s"}`
          }
          definition="Run-rate of every open let at its agreed rate."
        />
        <KpiCard
          label="Recurring / month"
          value={gbp(r.recurring.perMonth)}
          definition="The same run-rate expressed monthly (week × 52 ÷ 12)."
        />
        <KpiCard
          label="Avg weekly rate"
          value={r.avgWeeklyRate != null ? gbp(r.avgWeeklyRate) : "—"}
          definition="Average agreed rate per occupied, priced unit."
        />
        <KpiCard
          label="Earned to date"
          value={gbp(r.earnedToDate)}
          definition="Estimate from the let history — the invoicing row below is what was actually billed."
        />
      </div>

      {/* invoicing — real numbers from the billing cron (phase 2) */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Billed to date"
          value={gbp(billing.billed)}
          sub={`${billing.invoiceCount} invoice${billing.invoiceCount === 1 ? "" : "s"}`}
          definition="Every storage invoice raised in Zoho by the nightly billing run (void/errors excluded)."
        />
        <KpiCard
          label="Paid"
          value={gbp(billing.paid)}
          sub={`${billing.paidCount} invoice${billing.paidCount === 1 ? "" : "s"}`}
          definition="Invoices Zoho shows as settled."
        />
        <KpiCard
          label="Outstanding"
          value={gbp(billing.outstanding)}
          sub={`${billing.outstandingCount} invoice${billing.outstandingCount === 1 ? "" : "s"}`}
          definition="Raised but not yet paid."
        />
        <KpiCard
          label="Overdue"
          value={String(billing.overdueCount)}
          sub={billing.overdueCount ? "chase these" : "all current"}
          definition="Unpaid invoices whose billing period started 14+ days ago."
        />
      </div>

      {/* durations + by-type */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-0">
          <div className="border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">How long customers stay</h2>
          </div>
          <div className="grid grid-cols-2 divide-x">
            <div className="p-5">
              <p className="font-display text-3xl font-bold tabular text-foreground">
                {r.avgLetWeeks != null ? `${r.avgLetWeeks} wk${r.avgLetWeeks === 1 ? "" : "s"}` : "—"}
              </p>
              <p className="text-xs leading-snug text-mist-400">Average length of completed lets.</p>
            </div>
            <div className="p-5">
              <p className="font-display text-3xl font-bold tabular text-foreground">
                {r.longestOpenWeeks != null ? `${r.longestOpenWeeks} wk${r.longestOpenWeeks === 1 ? "" : "s"}` : "—"}
              </p>
              <p className="text-xs leading-snug text-mist-400">Longest let still running today.</p>
            </div>
          </div>
        </Card>

        <Card className="p-0">
          <div className="border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Units by type</h2>
          </div>
          {r.byType.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-mist-400">No units yet.</p>
          ) : (
            <div className="space-y-2.5 p-5">
              {r.byType.map((t) => (
                <div key={t.type} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 truncate text-sm text-foreground">{TYPE_LABEL[t.type] ?? t.type}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-pill bg-mist-100">
                    <div
                      className="h-full rounded-pill bg-mm-red"
                      style={{ width: `${t.total ? Math.round((t.occupied / t.total) * 100) : 0}%` }}
                    />
                  </div>
                  <span className="tabular w-16 shrink-0 text-right text-sm text-mist-500">
                    <span className="font-semibold text-foreground">{t.occupied}</span>/{t.total}
                  </span>
                </div>
              ))}
              <p className="pt-1 text-xs text-mist-400">Occupied of total, per unit type.</p>
            </div>
          )}
        </Card>
      </div>

      {/* current lets */}
      <Card className="p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">Who&apos;s in storage now</h2>
          <Link href="/storage" className="text-xs text-mist-400 underline-offset-2 hover:underline">
            Manage storage →
          </Link>
        </div>
        {currentLets.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">No open lets.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="eyebrow px-5 py-3 font-semibold">Client</th>
                  <th className="eyebrow px-2 py-3 font-semibold">Unit</th>
                  <th className="eyebrow px-2 py-3 font-semibold">Since</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Weeks</th>
                  <th className="eyebrow px-5 py-3 text-right font-semibold">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {currentLets.map((l) => (
                  <tr key={l.id}>
                    <td className="px-5 py-3">
                      <Link href={`/clients/${l.client_id}`} className="font-medium text-foreground hover:underline">
                        {l.client_name}
                      </Link>
                    </td>
                    <td className="px-2 py-3 text-mist-500">
                      {l.unit_label}
                      <span className="text-mist-300"> · </span>
                      {l.site_name}
                    </td>
                    <td className="px-2 py-3 text-mist-500">{fmtDate(l.start_date)}</td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{l.weeks}</td>
                    <td className="tabular px-5 py-3 text-right font-semibold text-foreground">
                      {l.rate != null ? `${gbp(Number(l.rate))}/${l.rate_period === "month" ? "mo" : "wk"}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-mist-400">
        Run-rate figures come from agreed let rates; the invoicing row is what the nightly billing run actually
        raised in Zoho, with paid status refreshed daily.
      </p>
    </div>
  );
}
