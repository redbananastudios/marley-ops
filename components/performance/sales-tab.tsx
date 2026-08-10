import Link from "next/link";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { LEAD_STATUS_META } from "@/components/lead-status-badge";
import type { SalesReport } from "@/lib/sales-report";

/**
 * Performance → Sales tab (presentational; the numbers come from
 * lib/sales-report.ts). Every KPI prints its definition under the number —
 * the iMVE pattern worth stealing: nobody argues about what a card means
 * when the card says it.
 */

const gbp = (n: number): string => "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export interface RangePreset {
  key: string;
  label: string;
}

export const RANGE_PRESETS: RangePreset[] = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "last-30", label: "Last 30 days" },
  { key: "last-90", label: "Last 90 days" },
  { key: "this-year", label: "This year" },
  { key: "all", label: "All time" },
];

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

const FUNNEL_SEGMENTS = [
  { key: "accepted", label: "Accepted", color: "#3F9B6B" },
  { key: "awaiting", label: "Awaiting response", color: "#C0822E" },
  { key: "declined", label: "Declined", color: "#C03838" },
  { key: "lost", label: "Lost / lapsed", color: "#A1A1AA" },
] as const;

export function SalesTab({
  report,
  rangeLabel,
  preset,
  from,
  to,
}: {
  report: SalesReport;
  rangeLabel: string;
  preset: string;
  from: string;
  to: string;
}) {
  const r = report;
  return (
    <div className="space-y-6">
      {/* range picker — links for presets + a plain GET form for custom */}
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn(segmentedTrackClass, "flex-wrap")}>
          {RANGE_PRESETS.map((p) => (
            <Link
              key={p.key}
              href={`/performance?tab=sales&range=${p.key}`}
              aria-current={preset === p.key ? "true" : undefined}
              className={segmentedItemClass(preset === p.key)}
            >
              {p.label}
            </Link>
          ))}
        </div>
        <form method="get" action="/performance" className="flex items-center gap-1.5">
          <input type="hidden" name="tab" value="sales" />
          <input type="hidden" name="range" value="custom" />
          <input
            type="date"
            name="from"
            defaultValue={from}
            aria-label="From date"
            className="focus-ring h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground"
          />
          <span className="text-xs text-mist-400">to</span>
          <input
            type="date"
            name="to"
            defaultValue={to}
            aria-label="To date"
            className="focus-ring h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground"
          />
          <button
            type="submit"
            className="focus-ring min-h-9 rounded-md border border-input bg-card px-3 text-sm font-medium text-mist-500 transition-colors hover:bg-muted hover:text-foreground"
          >
            Go
          </button>
        </form>
        <span className="ml-auto text-xs text-mist-400">{rangeLabel}</span>
      </div>

      {/* the four revenue lenses */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Revenue generated"
          value={gbp(r.generated.total)}
          sub={`${r.generated.count} job${r.generated.count === 1 ? "" : "s"}`}
          definition="Value of booked jobs with a move date in this period."
        />
        <KpiCard
          label="Revenue paid"
          value={gbp(r.paid.total)}
          sub={`${r.paid.count} payment${r.paid.count === 1 ? "" : "s"}`}
          definition="Money actually received in this period — deposits plus balances."
        />
        <KpiCard
          label="Projected revenue"
          value={gbp(r.projected.total)}
          sub={`${r.projected.count} won`}
          definition="Value of quotes accepted in this period, whenever the move happens."
        />
        <KpiCard
          label="Potential revenue"
          value={gbp(r.potential.total)}
          sub={`${r.potential.count} quoted`}
          definition="Value of all quotes sent in this period — one quote per job."
        />
      </div>

      {/* operating KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Jobs completed"
          value={String(r.jobsCompleted)}
          definition="Booked jobs that moved in this period and are marked completed."
        />
        <KpiCard
          label="Conversion rate"
          value={r.conversionPct != null ? `${r.conversionPct}%` : "—"}
          sub={`${r.won} of ${r.enquiries}`}
          definition="Of enquiries received in this period, the share won so far."
        />
        <KpiCard
          label="Avg job value"
          value={r.avgJobValue != null ? gbp(r.avgJobValue) : "—"}
          definition="Projected revenue divided by quotes won in this period."
        />
        <KpiCard
          label="Quoted by visit day"
          value={r.sameDay.pct != null ? `${r.sameDay.pct}%` : "—"}
          sub={r.sameDay.of ? `${r.sameDay.same} of ${r.sameDay.of}` : undefined}
          definition="Surveyed jobs quoted on or before the day of the visit — speed wins work."
        />
      </div>

      {/* quote funnel */}
      <Card className="p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">Quote funnel</h2>
          <span className="text-xs text-mist-400">
            {r.funnel.sent} sent · one quote per job{r.funnel.pct != null ? ` · ${r.funnel.pct}% accepted` : ""}
          </span>
        </div>
        {r.funnel.sent === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">No quotes sent in this period.</p>
        ) : (
          <div className="space-y-3 p-5">
            <div className="flex h-3 overflow-hidden rounded-pill bg-mist-100">
              {FUNNEL_SEGMENTS.map((s) =>
                r.funnel[s.key] > 0 ? (
                  <div
                    key={s.key}
                    title={`${s.label}: ${r.funnel[s.key]}`}
                    style={{ width: `${(r.funnel[s.key] / r.funnel.sent) * 100}%`, backgroundColor: s.color }}
                  />
                ) : null,
              )}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {FUNNEL_SEGMENTS.map((s) => (
                <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-mist-500">
                  <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                  {s.label} <span className="tabular font-semibold text-foreground">{r.funnel[s.key]}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* revenue by source */}
      <Card className="p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">Where the work comes from</h2>
          <span className="text-xs text-mist-400">Enquiries in this period, credited to their source.</span>
        </div>
        {r.bySource.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">No enquiries in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="eyebrow px-5 py-3 font-semibold">Source</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Enquiries</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Won</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Win rate</th>
                  <th className="eyebrow px-5 py-3 text-right font-semibold">Won value</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {r.bySource.map((s) => (
                  <tr key={s.key}>
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-2 font-medium text-foreground">
                        <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                        {s.label}
                      </span>
                    </td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{s.enquiries}</td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{s.won}</td>
                    <td className="tabular px-2 py-3 text-right text-mist-500">
                      {s.enquiries ? Math.round((s.won / s.enquiries) * 100) : 0}%
                    </td>
                    <td className="tabular px-5 py-3 text-right font-semibold text-foreground">
                      {s.value > 0 ? gbp(s.value) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* what happened to the period's enquiries */}
      <Card className="p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">Where those enquiries are now</h2>
          <Link href="/board" className="text-xs text-mist-400 underline-offset-2 hover:underline">
            Open the board →
          </Link>
        </div>
        {r.statusCounts.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">No enquiries in this period.</p>
        ) : (
          <div className="flex flex-wrap gap-2 p-5">
            {r.statusCounts.map((s) => (
              <span
                key={s.status}
                className="inline-flex items-center gap-2 rounded-pill border border-border bg-card px-3 py-1.5 text-sm"
              >
                <span className="text-mist-500">
                  {LEAD_STATUS_META[s.status as keyof typeof LEAD_STATUS_META]?.label ?? s.status}
                </span>
                <span className="tabular font-semibold text-foreground">{s.count}</span>
              </span>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
