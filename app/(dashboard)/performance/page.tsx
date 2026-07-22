import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { segmentedItemClass, segmentedTrackClass } from "@/components/ui/segmented";
import { aggregateEstimators, type EstimatorVisit } from "@/lib/estimator";
import { getBusinessSettings } from "@/lib/settings";
import { jobCost, marginPct, boxesFromItems, commissionCost } from "@/lib/margin";
import { lossReasonLabel } from "@/lib/quote/chase";
import type { QuoteBreakdown } from "@/lib/quote/pricing";
import { SalesTab } from "@/components/performance/sales-tab";
import { StorageTab, type CurrentLetRow } from "@/components/performance/storage-tab";
import { buildSalesReport, type SalesLead, type SalesQuote } from "@/lib/sales-report";
import { buildStorageBillingStats, buildStorageCostReport, buildStorageReport, letWeeks } from "@/lib/storage-report";
import { getSupplierRates } from "@/lib/storage-supplier";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { ukInstant, ukParts, UK_TZ } from "@/lib/uk-time";

export const dynamic = "force-dynamic";

const gbp = (n: number): string => "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pad = (n: number) => String(n).padStart(2, "0");

const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** yyyy-mm-dd ± n days (pure date strings). */
function addDaysStr(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Resolve a range preset to inclusive UK day bounds + a human label. */
function resolveRange(preset: string, fromQ?: string, toQ?: string): { from: string; to: string; label: string } {
  const now = ukParts();
  const day = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
  const today = day(now.year, now.month, now.day);
  const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  switch (preset) {
    case "last-month": {
      const y = now.month === 1 ? now.year - 1 : now.year;
      const m = now.month === 1 ? 12 : now.month - 1;
      return { from: day(y, m, 1), to: day(y, m, lastOfMonth(y, m)), label: "the previous calendar month" };
    }
    case "last-30":
      return { from: addDaysStr(today, -29), to: today, label: "the last 30 days" };
    case "last-90":
      return { from: addDaysStr(today, -89), to: today, label: "the last 90 days" };
    case "this-year":
      return { from: day(now.year, 1, 1), to: day(now.year, 12, 31), label: `${now.year} to date and booked ahead` };
    case "all":
      return { from: "2000-01-01", to: "2099-12-31", label: "all time" };
    case "custom":
      if (isDay(fromQ) && isDay(toQ) && fromQ <= toQ)
        return { from: fromQ, to: toQ, label: `${fmt(fromQ)} – ${fmt(toQ)}` };
      break;
  }
  return { from: day(now.year, now.month, 1), to: day(now.year, now.month, lastOfMonth(now.year, now.month)), label: "this calendar month" };
}

type SearchParams = { month?: string; tab?: string; range?: string; from?: string; to?: string };

function TabBar({ active }: { active: "overview" | "sales" | "storage" }) {
  const tab = (key: "overview" | "sales" | "storage", label: string, href: string) => (
    <Link href={href} aria-current={active === key ? "page" : undefined} className={segmentedItemClass(active === key)}>
      {label}
    </Link>
  );
  return (
    <div className={cn(segmentedTrackClass, "mb-5")}>
      {tab("overview", "Overview", "/performance")}
      {tab("sales", "Sales", "/performance?tab=sales")}
      {tab("storage", "Storage", "/performance?tab=storage")}
    </div>
  );
}

async function StorageTabPage() {
  const sb = await createClient();

  // Supplier-cost window = the current UK calendar month, accrued to TODAY —
  // crate days beyond today haven't been stored yet (PRD §6 "capped at end/today").
  const nowUk = ukParts();
  const today = `${nowUk.year}-${pad(nowUk.month)}-${pad(nowUk.day)}`;
  const monthStart = `${nowUk.year}-${pad(nowUk.month)}-01`;
  const costMonthLabel = new Date(`${monthStart}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const [{ data: sites }, { data: units }, lets, { data: clients }, supplier, handlingEvents] = await Promise.all([
    sb.from("storage_sites").select("id, name, is_active"),
    sb.from("storage_units").select("id, site_id, code, name, unit_type, is_active"),
    fetchAllRows((f, t) =>
      sb
        .from("storage_lets")
        .select("id, unit_id, client_id, start_date, end_date, rate, rate_period, billing_model")
        .order("id")
        .range(f, t),
    ),
    sb.from("clients").select("id, display_name"),
    // Supplier costs are admin-only (storage_supplier_rates RLS) — read with
    // the USER client so an estimator gets null and the cost card simply hides.
    // A transient read ERROR also hides the card (display-only surface).
    getSupplierRates(sb).catch(() => null),
    // This month's handling events — counted × the CURRENT supplier rate (the
    // row's amount is the customer charge, not the cost).
    fetchAllRows((f, t) =>
      sb
        .from("storage_handling_events")
        .select("event_date")
        .gte("event_date", monthStart)
        .lte("event_date", today)
        .order("id")
        .range(f, t),
    ),
  ]);
  // Full storage-invoice history feeds the billing stats (aggregation only, so
  // order-independent) → page through fetchAllRows past PostgREST's 1000-row cap.
  const storageInvoices = await fetchAllRows((f, t) =>
    sb.from("storage_invoices").select("amount, status, period_start").order("id").range(f, t),
  );

  const billing = buildStorageBillingStats(
    (storageInvoices ?? []).map((i) => ({ ...i, amount: Number(i.amount) })),
    today,
  );

  const letRows = lets.map((l) => ({
    id: l.id,
    unit_id: l.unit_id,
    client_id: l.client_id,
    start_date: l.start_date,
    end_date: l.end_date,
    rate: l.rate == null ? null : Number(l.rate),
    rate_period: l.rate_period,
    billing_model: (l as { billing_model?: string | null }).billing_model ?? null,
  }));

  const report = buildStorageReport(
    (sites ?? []).map((s) => ({ id: s.id, is_active: s.is_active })),
    units ?? [],
    letRows,
    today,
  );

  const cost = supplier
    ? buildStorageCostReport({
        lets: letRows,
        events: (handlingEvents ?? []) as { event_date: string }[],
        units: units ?? [],
        supplier,
        monthStartIso: monthStart,
        monthEndIso: today,
      })
    : null;

  const clientName = new Map((clients ?? []).map((c) => [c.id, c.display_name as string]));
  const unitById = new Map((units ?? []).map((u) => [u.id, u]));
  const siteName = new Map((sites ?? []).map((s) => [s.id, s.name as string]));
  const currentLets: CurrentLetRow[] = letRows
    .filter((l) => l.end_date == null)
    .map((l) => {
      const u = unitById.get(l.unit_id);
      return {
        id: l.id,
        client_id: l.client_id,
        client_name: clientName.get(l.client_id) ?? "Unknown client",
        unit_label: u ? u.code || u.name || "Unit" : "Unit",
        site_name: u ? siteName.get(u.site_id) ?? "—" : "—",
        start_date: l.start_date,
        rate: l.rate,
        rate_period: l.rate_period,
        weeks: letWeeks(l.start_date, today),
      };
    })
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Reports" title="Performance" />
      <TabBar active="storage" />
      <StorageTab report={report} currentLets={currentLets} billing={billing} cost={cost} costMonthLabel={costMonthLabel} />
    </main>
  );
}

async function SalesTabPage({ sp }: { sp: SearchParams }) {
  const preset = sp.range ?? "this-month";
  const { from, to, label } = resolveRange(preset, sp.from, sp.to);
  const sb = await createClient();

  const [quotes, leads, surveys] = await Promise.all([
    fetchAllRows((f, t) =>
      sb
        .from("quotes")
        .select(
          "id, lead_id, status, grand_total, agreed_price, created_at, email_sent_at, accepted_at, moving_date, deposit_amount, deposit_paid_at",
        )
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      sb
        .from("leads")
        .select(
          "id, status, submitted_at, created_at, preferred_date, balance_amount, balance_paid_at, entry_channel, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium",
        )
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      sb
        .from("appointments")
        .select("lead_id, starts_at")
        .eq("appt_type", "survey")
        .eq("status", "completed")
        .order("id")
        .range(f, t),
    ),
  ]);

  const report = buildSalesReport(quotes as SalesQuote[], leads as SalesLead[], surveys, from, to);

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Reports" title="Performance" />
      <TabBar active="sales" />
      <SalesTab report={report} rangeLabel={`Showing ${label}.`} preset={preset} from={from} to={to} />
    </main>
  );
}

export default async function PerformancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  if (sp.tab === "sales") return <SalesTabPage sp={sp} />;
  if (sp.tab === "storage") return <StorageTabPage />;
  const nowUk = ukParts();
  const m = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month!.split("-") : null;
  const year = m ? Number(m[0]) : nowUk.year;
  const month0 = m ? Number(m[1]) - 1 : nowUk.month - 1;
  // Month boundaries as UK-midnight instants (the panel runs on UK time).
  const monthStart = ukInstant(year, month0 + 1, 1);
  const monthEnd = ukInstant(year, month0 + 2, 1);
  const prev = new Date(Date.UTC(year, month0 - 1, 1));
  const next = new Date(Date.UTC(year, month0 + 1, 1));
  const prevHref = `/performance?month=${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}`;
  const nextHref = `/performance?month=${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}`;
  const monthLabel = monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: UK_TZ });

  const sb = await createClient();
  const [{ data: appts }, { data: profiles }, leads, quotes] =
    await Promise.all([
      sb
        .from("appointments")
        .select("id, starts_at, estimator_id, lead_id")
        .eq("appt_type", "survey")
        .eq("status", "completed")
        .gte("starts_at", monthStart.toISOString())
        .lt("starts_at", monthEnd.toISOString()),
      sb.from("profiles").select("id, full_name"),
      // leads + quotes are full-table lookups (name/status maps, accepted-value
      // map) — order-independent → page through fetchAllRows so they aren't
      // truncated at PostgREST's 1000-row cap once the business grows.
      fetchAllRows((f, t) => sb.from("leads").select("id, name, status, referral_commission").order("id").range(f, t)),
      fetchAllRows((f, t) => sb.from("quotes").select("lead_id, status, agreed_price, grand_total").order("id").range(f, t)),
    ]);

  // Accepted quotes in this month = the booked jobs we score margin on.
  const { data: acceptedQuotes } = await sb
    .from("quotes")
    .select("id, quote_ref, customer_name, lead_id, agreed_price, grand_total, breakdown, state_blob, accepted_at")
    .eq("status", "accepted")
    .gte("accepted_at", monthStart.toISOString())
    .lt("accepted_at", monthEnd.toISOString())
    .order("accepted_at", { ascending: false });

  // Losses this month, grouped by reason (mark-lost dialog + 30-day auto-lapse).
  const { data: lostLeads } = await sb
    .from("leads")
    .select("lost_reason")
    .eq("status", "declined")
    .gte("lost_at", monthStart.toISOString())
    .lt("lost_at", monthEnd.toISOString());
  const lostCounts = new Map<string, number>();
  for (const l of lostLeads ?? []) {
    const r = (l.lost_reason as string | null) ?? "unrecorded";
    lostCounts.set(r, (lostCounts.get(r) ?? 0) + 1);
  }
  const lostRows = [...lostCounts.entries()].sort((a, b) => b[1] - a[1]);
  const lostTotal = lostRows.reduce((s, [, n]) => s + n, 0);

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

  // Lead-level 3rd-party referral fees — a real cost of the jobs they became.
  const commissionByLead = new Map(
    (leads ?? []).map((l) => [
      l.id as string,
      commissionCost((l as { referral_commission?: number | string | null }).referral_commission),
    ]),
  );

  // Per-job margin for the month's booked jobs (cost assumes 1-day jobs for now).
  const jobs = (acceptedQuotes ?? []).map((q) => {
    const b = (q.breakdown ?? {}) as Partial<QuoteBreakdown>;
    const blob = (q.state_blob as { items?: Record<string, number>; job?: { days?: number } } | null) ?? null;
    const revenue = Number(q.agreed_price ?? q.grand_total ?? 0);
    const cost = jobCost(
      {
        vehicle: b.vehicle ?? "1luton",
        sevenFiveT: b.sevenFiveT ?? (b.has75T ? 1 : 0),
        totalMiles: Number(b.totalMiles ?? 0),
        boxes: boxesFromItems(blob?.items),
        days: Math.max(1, Number(blob?.job?.days ?? 1)),
      },
      settings,
    );
    const commission = q.lead_id ? commissionByLead.get(q.lead_id) ?? 0 : 0;
    const totalCost = cost.total + commission;
    return {
      id: q.id,
      ref: q.quote_ref,
      customer: q.customer_name || (q.lead_id ? leadName.get(q.lead_id) ?? "—" : "—"),
      leadId: q.lead_id,
      revenue,
      commission,
      cost: totalCost,
      margin: revenue - totalCost,
      marginPct: marginPct(revenue, totalCost),
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

      <TabBar active="overview" />

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
                  <th className="eyebrow px-5 py-3 text-right font-semibold">Fee owed</th>
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
                    <td className="tabular px-5 py-3 text-right font-semibold text-foreground">{gbp(e.fee)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t">
                  <td className="px-5 py-3 text-sm font-semibold text-foreground" colSpan={5}>
                    Total fees
                  </td>
                  <td className="tabular px-5 py-3 text-right font-display text-base font-bold text-foreground">{gbp(totalFee)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      <p className="mt-2 text-xs text-mist-400">
        This is a reporting view. Estimators are paid through their own weekly contractor invoices (Finance → Contractor pay),
        which also cover telephone quotes and completion commission.
      </p>

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
                    {v.date
                      ? new Date(v.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: UK_TZ })
                      : "—"}
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
                  <th scope="col" className="eyebrow px-5 py-3 font-semibold">Job</th>
                  <th scope="col" className="eyebrow px-2 py-3 text-right font-semibold">Revenue</th>
                  <th scope="col" className="eyebrow px-2 py-3 text-right font-semibold">Est. cost</th>
                  <th scope="col" className="eyebrow px-2 py-3 text-right font-semibold">Margin</th>
                  <th scope="col" className="eyebrow px-5 py-3 text-right font-semibold">Margin %</th>
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
                    <td className="tabular px-2 py-3 text-right text-mist-500">
                      {gbp(j.cost)}
                      {j.commission > 0 ? (
                        <span className="block text-[11px] text-mist-400">incl. {gbp(j.commission)} commission</span>
                      ) : null}
                    </td>
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

      {/* Why we lose quotes — the improvement loop from the mark-lost reasons. */}
      <Card className="p-0">
        <div className="flex items-baseline gap-3 border-b px-5 py-3.5">
          <h2 className="font-display text-lg text-foreground">Lost quotes — why</h2>
          <span className="text-xs text-mist-400">{monthLabel}</span>
        </div>
        {lostRows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-mist-400">No losses recorded this month.</p>
        ) : (
          <div className="space-y-2 p-5">
            {lostRows.map(([reason, count]) => (
              <div key={reason} className="flex items-center gap-3">
                <span className="w-44 shrink-0 text-sm text-foreground">{lossReasonLabel(reason)}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-pill bg-mist-100">
                  <div
                    className="h-full rounded-pill bg-mm-red"
                    style={{ width: `${Math.round((count / lostTotal) * 100)}%` }}
                  />
                </div>
                <span className="tabular w-8 text-right text-sm font-semibold text-foreground">{count}</span>
              </div>
            ))}
            <p className="pt-1 text-xs text-mist-400">
              {lostTotal} lost · &quot;No response&quot; includes quotes that lapsed after the full chase sequence.
            </p>
          </div>
        )}
      </Card>
    </main>
  );
}
