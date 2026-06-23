import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { aggregateEstimators, type EstimatorVisit } from "@/lib/estimator";
import { getBusinessSettings } from "@/lib/settings";
import { jobCost, marginPct, boxesFromItems } from "@/lib/margin";
import type { QuoteBreakdown } from "@/lib/quote/pricing";
import { MarkPaidButton } from "@/components/performance/mark-paid-button";

export const dynamic = "force-dynamic";

const gbp = (n: number): string => "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pad = (n: number) => String(n).padStart(2, "0");

export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const now = new Date();
  const m = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month!.split("-") : null;
  const year = m ? Number(m[0]) : now.getFullYear();
  const month0 = m ? Number(m[1]) - 1 : now.getMonth();
  const monthStart = new Date(year, month0, 1);
  const monthEnd = new Date(year, month0 + 1, 1);
  const periodMonth = `${year}-${pad(month0 + 1)}-01`;
  const prev = new Date(year, month0 - 1, 1);
  const next = new Date(year, month0 + 1, 1);
  const prevHref = `/performance?month=${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`;
  const nextHref = `/performance?month=${next.getFullYear()}-${pad(next.getMonth() + 1)}`;
  const monthLabel = monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  const sb = await createClient();
  const [{ data: appts }, { data: profiles }, { data: leads }, { data: quotes }, { data: payouts }] =
    await Promise.all([
      sb
        .from("appointments")
        .select("id, starts_at, estimator_id, lead_id")
        .eq("appt_type", "survey")
        .eq("status", "completed")
        .gte("starts_at", monthStart.toISOString())
        .lt("starts_at", monthEnd.toISOString()),
      sb.from("profiles").select("id, full_name"),
      sb.from("leads").select("id, name, status"),
      sb.from("quotes").select("lead_id, status, agreed_price, grand_total"),
      sb.from("estimator_payouts").select("estimator_id, paid_at").eq("period_month", periodMonth),
    ]);

  // Accepted quotes in this month = the booked jobs we score margin on.
  const { data: acceptedQuotes } = await sb
    .from("quotes")
    .select("id, quote_ref, customer_name, lead_id, agreed_price, grand_total, breakdown, state_blob, accepted_at")
    .eq("status", "accepted")
    .gte("accepted_at", monthStart.toISOString())
    .lt("accepted_at", monthEnd.toISOString())
    .order("accepted_at", { ascending: false });

  const profileName = new Map((profiles ?? []).map((p) => [p.id, p.full_name as string]));
  const leadName = new Map((leads ?? []).map((l) => [l.id, l.name ?? "—"]));
  const wonLeadIds = new Set<string>();
  for (const l of leads ?? []) if (l.status === "confirmed" || l.status === "completed") wonLeadIds.add(l.id);
  const valueByLead = new Map<string, number>();
  for (const q of quotes ?? []) {
    if (q.lead_id && q.status === "accepted") {
      valueByLead.set(q.lead_id, Number(q.agreed_price ?? q.grand_total ?? 0));
      wonLeadIds.add(q.lead_id);
    }
  }
  const paidBy = new Map((payouts ?? []).map((p) => [p.estimator_id, !!p.paid_at]));

  const visits: EstimatorVisit[] = (appts ?? [])
    .filter((a) => a.estimator_id)
    .map((a) => ({
      apptId: a.id,
      estimatorId: a.estimator_id as string,
      estimatorName: profileName.get(a.estimator_id as string) ?? "Unknown",
      leadId: a.lead_id,
      customer: a.lead_id ? leadName.get(a.lead_id) ?? "—" : "—",
      date: a.starts_at,
      won: a.lead_id ? wonLeadIds.has(a.lead_id) : false,
      value: a.lead_id ? valueByLead.get(a.lead_id) ?? null : null,
    }))
    .sort((x, y) => new Date(y.date ?? 0).getTime() - new Date(x.date ?? 0).getTime());

  const settings = await getBusinessSettings(sb);
  const stats = aggregateEstimators(visits, settings.estimatorFee);
  const totalFee = stats.reduce((s, e) => s + e.fee, 0);

  // Per-job margin for the month's booked jobs (cost assumes 1-day jobs for now).
  const jobs = (acceptedQuotes ?? []).map((q) => {
    const b = (q.breakdown ?? {}) as Partial<QuoteBreakdown>;
    const blob = (q.state_blob as { items?: Record<string, number>; job?: { days?: number } } | null) ?? null;
    const revenue = Number(q.agreed_price ?? q.grand_total ?? 0);
    const cost = jobCost(
      {
        vehicle: b.vehicle ?? "1luton",
        has75T: b.has75T ?? false,
        totalMiles: Number(b.totalMiles ?? 0),
        boxes: boxesFromItems(blob?.items),
        days: Math.max(1, Number(blob?.job?.days ?? 1)),
      },
      settings,
    );
    return {
      id: q.id,
      ref: q.quote_ref,
      customer: q.customer_name || (q.lead_id ? leadName.get(q.lead_id) ?? "—" : "—"),
      leadId: q.lead_id,
      revenue,
      cost: cost.total,
      margin: revenue - cost.total,
      marginPct: marginPct(revenue, cost.total),
    };
  });
  const jobTotals = jobs.reduce(
    (a, j) => ({ revenue: a.revenue + j.revenue, cost: a.cost + j.cost, margin: a.margin + j.margin }),
    { revenue: 0, cost: 0, margin: 0 },
  );
  const totalMarginPct = marginPct(jobTotals.revenue, jobTotals.cost);

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Reports" title="Performance">
        <div className="flex items-center gap-1">
          <Link href={prevHref} aria-label="Previous month" className="focus-ring flex size-9 items-center justify-center rounded-md border border-input hover:bg-muted">
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </Link>
          <span className="min-w-[8.5rem] text-center text-sm font-medium text-foreground">{monthLabel}</span>
          <Link href={nextHref} aria-label="Next month" className="focus-ring flex size-9 items-center justify-center rounded-md border border-input hover:bg-muted">
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </Link>
        </div>
      </PageHeader>

      <p className="mb-4 text-sm text-mist-400">
        Attended survey visits this month, by estimator. Fee = visits × {gbp(settings.estimatorFee)} per visit.
      </p>

      {/* per-estimator payroll */}
      <Card className="p-0">
        {stats.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-mist-400">No completed visits in {monthLabel}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="eyebrow px-5 py-3 font-semibold">Estimator</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Visits</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Won</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Win rate</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">£ Won</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Fee owed</th>
                  <th className="eyebrow px-5 py-3 text-right font-semibold">Payroll</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stats.map((e) => (
                  <tr key={e.id}>
                    <td className="px-5 py-3 font-medium text-foreground">{e.name}</td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{e.visits}</td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{e.won}</td>
                    <td className="tabular px-2 py-3 text-right text-mist-500">{e.winRate}%</td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{e.wonValue > 0 ? gbp(e.wonValue) : "—"}</td>
                    <td className="tabular px-2 py-3 text-right font-semibold text-foreground">{gbp(e.fee)}</td>
                    <td className="px-5 py-3 text-right">
                      <MarkPaidButton
                        estimatorId={e.id}
                        periodMonth={periodMonth}
                        visits={e.visits}
                        amount={e.fee}
                        paid={paidBy.get(e.id) ?? false}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t">
                  <td className="px-5 py-3 text-sm font-semibold text-foreground" colSpan={5}>
                    Total fees
                  </td>
                  <td className="tabular px-2 py-3 text-right font-display text-base font-bold text-foreground">{gbp(totalFee)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* itemised visits */}
      {visits.length > 0 ? (
        <Card className="mt-6 p-0">
          <div className="border-b px-5 py-3.5">
            <h2 className="font-display text-lg font-semibold text-foreground">Visits this month</h2>
          </div>
          <ul className="divide-y">
            {visits.map((v) => (
              <li key={v.apptId} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {v.leadId ? <Link href={`/leads/${v.leadId}`} className="hover:underline">{v.customer}</Link> : v.customer}
                  </p>
                  <p className="text-xs text-mist-400">
                    {v.estimatorName} ·{" "}
                    {v.date ? new Date(v.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—"}
                  </p>
                </div>
                <span
                  className={
                    "rounded-pill px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide " +
                    (v.won ? "bg-success-bg text-success" : "bg-mist-100 text-mist-500")
                  }
                >
                  {v.won ? "Won" : "Open"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* jobs & margin */}
      <Card className="mt-6 p-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">Jobs &amp; margin</h2>
          <span className="text-xs text-mist-400">Booked this month. Cost uses each job&apos;s days, crew &amp; miles against your rate card.</span>
        </div>
        {jobs.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-mist-400">No jobs booked in {monthLabel}.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="eyebrow px-5 py-3 font-semibold">Job</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Revenue</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Est. cost</th>
                  <th className="eyebrow px-2 py-3 text-right font-semibold">Margin</th>
                  <th className="eyebrow px-5 py-3 text-right font-semibold">Margin %</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="px-5 py-3">
                      <p className="font-medium text-foreground">
                        {j.leadId ? <Link href={`/leads/${j.leadId}`} className="hover:underline">{j.customer}</Link> : j.customer}
                      </p>
                      <p className="text-xs text-mist-400">{j.ref}</p>
                    </td>
                    <td className="tabular px-2 py-3 text-right text-foreground">{gbp(j.revenue)}</td>
                    <td className="tabular px-2 py-3 text-right text-mist-500">{gbp(j.cost)}</td>
                    <td className={"tabular px-2 py-3 text-right font-semibold " + (j.margin < 0 ? "text-danger" : "text-foreground")}>{gbp(j.margin)}</td>
                    <td className={"tabular px-5 py-3 text-right font-semibold " + (j.margin < 0 ? "text-danger" : j.marginPct < 25 ? "text-warn" : "text-success")}>{j.marginPct}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t">
                  <td className="px-5 py-3 text-sm font-semibold text-foreground">Total ({jobs.length})</td>
                  <td className="tabular px-2 py-3 text-right font-semibold text-foreground">{gbp(jobTotals.revenue)}</td>
                  <td className="tabular px-2 py-3 text-right font-semibold text-mist-500">{gbp(jobTotals.cost)}</td>
                  <td className="tabular px-2 py-3 text-right font-display text-base font-bold text-foreground">{gbp(jobTotals.margin)}</td>
                  <td className="tabular px-5 py-3 text-right font-display text-base font-bold text-foreground">{totalMarginPct}%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}
