"use client";

/**
 * The dashboard — the daily "how is the business doing" view. A period toggle
 * (Today / This week / This month) re-scopes the whole page: headline KPIs,
 * conversion rates, leads by source, the enquiry→job funnel, a current-vs-previous
 * overlay chart, and the PostHog website drop-off funnel. Needs-action + recent
 * enquiries sit below (always "now"). Deliberately varied component styles so the
 * page reads as a dashboard, not a wall of identical cards.
 */

import { useState } from "react";
import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarCheck2,
  ChevronRight,
  Clock3,
  Minus,
  PhoneCall,
  Trophy,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { IconBadge } from "@/components/ui/icon-badge";
import { LeadStatusBadge } from "@/components/lead-status-badge";
import { OverlayChart } from "@/components/dashboard/overlay-chart";
import type { PeriodKey, PeriodStats } from "@/lib/dashboard/compute";

const gbp = (n: number): string => "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fmtDuration(mins: number | null): string {
  if (mins == null) return "—";
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = mins / 60;
  if (h < 24) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function timeAgo(d: string | null): string {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (Number.isNaN(diff)) return "—";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const PERIODS: PeriodKey[] = ["today", "week", "month"];

export interface DashboardData {
  periods: Record<PeriodKey, PeriodStats>;
  medianRespMins: number | null;
  needsAction: {
    newToAction: number;
    surveysToday: number;
    quotesAwaiting: number;
    followUpsDueToday: number;
    followUpsOverdue: number;
    /** Accepted, £deposit outstanding — the money half of the pipeline. */
    awaitingDeposit: number;
    /** Deposit paid, balance not settled — due in full before move day. */
    balanceDue: number;
    /** Active vehicles with tax/MOT/insurance due within 30 days or overdue. */
    fleetDocsDue: number;
    /** Accepted quotes with no contract signature — crew collect on arrival. */
    unsignedContracts: number;
  };
  recent: {
    id: string;
    name: string | null;
    status: string;
    source: string;
    when: string | null;
  }[];
  recentHeading: string;
  dateLabel: string;
}

export function DashboardView({ data }: { data: DashboardData }) {
  const [period, setPeriod] = useState<PeriodKey>("today");
  const s = data.periods[period];
  const delta = s.newLeads - s.prevNewLeads;

  return (
    <main className="page-shell flex-1 space-y-6">
      {/* header + period toggle */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{data.dateLabel}</p>
          <h1 className="font-display text-3xl font-semibold tracking-[-0.035em] text-foreground md:text-4xl">Dashboard</h1>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]" role="tablist" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={period === p}
              onClick={() => setPeriod(p)}
              className={
                "focus-ring rounded-[6px] px-3.5 py-1.5 text-sm font-medium capitalize transition-colors " +
                (period === p
                  ? "bg-card text-foreground shadow-xs"
                  : "text-mist-400 hover:text-foreground")
              }
            >
              {data.periods[p].label}
            </button>
          ))}
        </div>
      </header>

      {/* headline KPI strip */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="New leads" value={s.newLeads} icon={UserPlus} tone="red" accent>
          <Delta delta={delta} sub={s.vsLabel} />
        </Kpi>
        <Kpi label="Contacted" value={s.contacted} icon={PhoneCall} tone="blue" sub={`${pctOf(s.contacted, s.newLeads)} of leads`} />
        <Kpi label="Surveys booked" value={s.surveys} icon={CalendarCheck2} tone="teal" sub={`${s.leadToSurveyPct}% of leads`} />
        <Kpi label="Jobs won" value={s.jobs} icon={Trophy} tone="green" sub={s.wonValue > 0 ? gbp(s.wonValue) : `${s.leadToJobPct}% of leads`} good={s.jobs > 0} />
        <Kpi label="Median response" value={fmtDuration(data.medianRespMins)} icon={Clock3} tone="amber">
          <span className="text-xs text-mist-400">to first contact</span>
        </Kpi>
      </section>

      {/* conversion rings */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <RingStat label="Lead → Survey" pct={s.leadToSurveyPct} color="#C0822E" caption={`${s.surveys}/${s.newLeads}`} />
        <RingStat label="Survey → Job" pct={s.surveyToJobPct} color="#3F9B6B" caption={`${s.jobs}/${s.surveys}`} />
        <RingStat label="Lead → Job" pct={s.leadToJobPct} color="#c03838" caption={`${s.jobs}/${s.newLeads}`} />
      </section>

      {/* profit / margin */}
      <MarginCard revenue={s.wonValue} cost={s.wonCost} margin={s.margin} marginPct={s.marginPct} jobs={s.jobs} />

      {/* paid performance */}
      <PaidCard adSpend={s.adSpend} paidLeads={s.paidLeads} paidWonValue={s.paidWonValue} />

      {/* estimator performance */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <p className="eyebrow">Estimator performance</p>
          <Link href="/performance" className="focus-ring rounded-sm text-xs text-mm-red hover:underline">
            Payroll →
          </Link>
        </div>
        {s.estimators.length === 0 ? (
          <p className="py-4 text-center text-sm text-mist-400">No completed visits this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="eyebrow pb-2 font-semibold">Estimator</th>
                  <th className="eyebrow pb-2 text-right font-semibold">Visits</th>
                  <th className="eyebrow pb-2 text-right font-semibold">Won</th>
                  <th className="eyebrow pb-2 text-right font-semibold">Win&nbsp;rate</th>
                  <th className="eyebrow pb-2 text-right font-semibold">£&nbsp;Won</th>
                  <th className="eyebrow pb-2 text-right font-semibold">Fee</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {s.estimators.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 font-medium text-foreground">{e.name}</td>
                    <td className="tabular py-2 text-right text-foreground">{e.visits}</td>
                    <td className="tabular py-2 text-right text-foreground">{e.won}</td>
                    <td className="tabular py-2 text-right text-mist-500">{e.winRate}%</td>
                    <td className="tabular py-2 text-right text-foreground">{e.wonValue > 0 ? gbp(e.wonValue) : "—"}</td>
                    <td className="tabular py-2 text-right font-semibold text-foreground">{gbp(e.fee)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* sources */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="eyebrow">Where leads came from</p>
            <span className="text-xs text-mist-400 capitalize">{s.label.toLowerCase()}</span>
          </div>
          <SourceBars sources={s.sources} total={s.newLeads} />
          {s.topCampaigns.length > 0 ? (
            <div className="mt-5 border-t border-border pt-4">
              <p className="eyebrow mb-2">Top campaigns</p>
              <ul className="space-y-1.5">
                {s.topCampaigns.map((c) => (
                  <li key={c.campaign} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-mist-500">{c.campaign}</span>
                    <span className="tabular shrink-0 text-foreground">{c.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        {/* funnel */}
        <Card className="p-5">
          <p className="eyebrow mb-4">Enquiry → job funnel</p>
          <Funnel stats={s} />
        </Card>
      </div>

      {/* overlay chart */}
      <Card className="p-5">
        <OverlayChart
          buckets={s.buckets}
          label={s.chartLabel}
          current={s.newLeads}
          previous={s.prevNewLeads}
        />
      </Card>

      {/* website behaviour (PostHog) */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <p className="eyebrow">Website behaviour</p>
          <span className="text-xs text-mist-400">PostHog · {s.label.toLowerCase()}</span>
        </div>
        {s.posthog ? (
          <WebFunnel ph={s.posthog} />
        ) : (
          <p className="py-6 text-center text-sm text-mist-400">
            PostHog data unavailable right now.
          </p>
        )}
      </Card>

      {/* needs action (now) */}
      <section>
        <p className="eyebrow mb-2">Needs action now</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <ActionCard label="Follow-ups overdue" count={data.needsAction.followUpsOverdue} href="/follow-ups" accent empty="Nothing overdue" />
          <ActionCard label="Follow-ups due today" count={data.needsAction.followUpsDueToday} href="/follow-ups" empty="None due today" />
          <ActionCard label="New enquiries to action" count={data.needsAction.newToAction} href="/leads?status=website_enquiry" accent empty="All enquiries triaged" />
          <ActionCard label="Surveys today" count={data.needsAction.surveysToday} href="/schedule/surveys" empty="No surveys today" />
          <ActionCard label="Quotes awaiting reply" count={data.needsAction.quotesAwaiting} href="/quotes" empty="No quotes pending" />
          <ActionCard label="Awaiting deposit" count={data.needsAction.awaitingDeposit} href="/bookings" accent empty="No deposits outstanding" />
          <ActionCard label="Balance due" count={data.needsAction.balanceDue} href="/bookings" empty="No balances outstanding" />
          <ActionCard label="Fleet docs due" count={data.needsAction.fleetDocsDue} href="/resources?tab=vehicles" empty="Fleet in date" />
          <ActionCard label="Unsigned contracts" count={data.needsAction.unsignedContracts} href="/documents?tab=unsigned" accent empty="All contracts signed" />
        </div>
      </section>

      {/* recent enquiries */}
      <Card className="p-0">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="font-display text-lg font-semibold text-foreground">{data.recentHeading}</h2>
          <Link href="/leads" className="focus-ring rounded-sm text-sm text-mm-red hover:underline">
            View all
          </Link>
        </div>
        {data.recent.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-mist-400">No leads yet.</p>
        ) : (
          <ul className="divide-y">
            {data.recent.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/leads/${r.id}`}
                  className="focus-ring flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{r.name ?? "—"}</p>
                    <p className="truncate text-xs text-mist-400">
                      {r.source} · {timeAgo(r.when)}
                    </p>
                  </div>
                  <LeadStatusBadge status={r.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}

/* ------------------------------- pieces -------------------------------- */

const pctOf = (n: number, d: number): string => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

function Kpi({
  label,
  value,
  sub,
  accent,
  good,
  icon,
  tone = "neutral",
  children,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent?: boolean;
  good?: boolean;
  icon: LucideIcon;
  tone?: "red" | "blue" | "teal" | "green" | "amber" | "violet" | "neutral";
  children?: React.ReactNode;
}) {
  return (
    <Card
      className={
        "relative gap-0 overflow-hidden border-t-2 p-4 " +
        (tone === "red"
          ? "border-t-mm-red"
          : tone === "blue"
            ? "border-t-info"
            : tone === "teal"
              ? "border-t-survey"
              : tone === "green"
                ? "border-t-success"
                : tone === "amber"
                  ? "border-t-amber-500"
                  : tone === "violet"
                    ? "border-t-violet"
                    : "border-t-mist-300")
      }
    >
      <div className="flex items-start gap-3">
        <IconBadge icon={icon} tone={tone} className="size-9" iconClassName="size-[18px]" />
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{label}</p>
          <p
            className={
              "mt-1 font-display tabular text-3xl font-bold " +
              (accent ? "text-mm-red" : good ? "text-success" : "text-foreground")
            }
          >
            {value}
          </p>
          {children ? <div className="mt-1">{children}</div> : sub ? <p className="mt-1 text-xs text-mist-400">{sub}</p> : null}
        </div>
      </div>
    </Card>
  );
}

function Delta({ delta, sub }: { delta: number; sub: string }) {
  return (
    <p className="flex items-center gap-1 text-xs text-mist-400">
      {delta > 0 ? (
        <ArrowUpRight className="size-3.5 text-success" strokeWidth={2} />
      ) : delta < 0 ? (
        <ArrowDownRight className="size-3.5 text-mm-red" strokeWidth={2} />
      ) : (
        <Minus className="size-3.5 text-mist-400" strokeWidth={2} />
      )}
      <span className="tabular">
        {delta > 0 ? "+" : ""}
        {delta}
      </span>
      <span>· {sub}</span>
    </p>
  );
}

const gbp2 = (n: number): string =>
  "£" + n.toFixed(2).replace(/\.00$/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function MarginCard({
  revenue,
  cost,
  margin,
  marginPct,
  jobs,
}: {
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number;
  jobs: number;
}) {
  if (jobs === 0) {
    return (
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="eyebrow">Profit this period</p>
          <span className="text-xs text-mist-400">Won jobs · est. cost</span>
        </div>
        <p className="py-4 text-center text-sm text-mist-400">No jobs won in this period yet.</p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="eyebrow">Profit this period</p>
        <span className="text-xs text-mist-400">{jobs} won · est. cost from rate card</span>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <PaidStat label="Booked revenue" value={gbp(revenue)} />
        <PaidStat label="Est. cost" value={gbp(cost)} />
        <PaidStat label="Margin" value={gbp(margin)} good={margin >= 0} bad={margin < 0} />
        <PaidStat label="Margin %" value={`${marginPct}%`} good={margin >= 0} bad={margin < 0} />
      </div>
    </Card>
  );
}

function PaidCard({
  adSpend,
  paidLeads,
  paidWonValue,
}: {
  adSpend: number | null;
  paidLeads: number;
  paidWonValue: number;
}) {
  if (adSpend == null) {
    return (
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="eyebrow">Paid performance</p>
          <span className="text-xs text-mist-400">Google Ads</span>
        </div>
        <p className="py-4 text-center text-sm text-mist-400">Google Ads data unavailable right now.</p>
      </Card>
    );
  }
  const cpl = paidLeads > 0 ? adSpend / paidLeads : null;
  const roas = adSpend > 0 ? paidWonValue / adSpend : null;
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="eyebrow">Paid performance</p>
        <span className="text-xs text-mist-400">Google Ads · this period</span>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <PaidStat label="Ad spend" value={gbp2(adSpend)} />
        <PaidStat label="Cost per lead" value={cpl == null ? "—" : gbp2(cpl)} sub={`${paidLeads} paid leads`} />
        <PaidStat label="Won from ads" value={paidWonValue > 0 ? gbp2(paidWonValue) : "—"} good={paidWonValue > 0} />
        <PaidStat
          label="ROAS"
          value={roas == null || paidWonValue === 0 ? "—" : `${roas.toFixed(1)}×`}
          good={roas != null && roas >= 1}
          bad={roas != null && paidWonValue > 0 && roas < 1}
          sub={paidWonValue === 0 ? "no won revenue yet" : "won ÷ spend"}
        />
      </div>
      <p className="mt-4 border-t border-border pt-3 text-xs text-mist-400">
        Meta not connected — add an ad-account ID + ads_read token to include Meta spend.
      </p>
    </Card>
  );
}

function PaidStat({
  label,
  value,
  sub,
  good,
  bad,
}: {
  label: string;
  value: string;
  sub?: string;
  good?: boolean;
  bad?: boolean;
}) {
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <p
        className={
          "mt-1 font-display tabular text-2xl font-bold " +
          (good ? "text-success" : bad ? "text-mm-red" : "text-foreground")
        }
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </div>
  );
}

function RingStat({ label, pct, color, caption }: { label: string; pct: number; color: string; caption: string }) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(100, pct) / 100) * circ;
  return (
    <Card className="flex-row items-center gap-3 p-4">
      <svg viewBox="0 0 64 64" className="size-14 shrink-0 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#f4f4f5" strokeWidth="7" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
        />
      </svg>
      <div className="min-w-0">
        <p className="font-display tabular text-2xl font-bold leading-none text-foreground">{pct}%</p>
        <p className="mt-1 truncate text-xs font-medium text-foreground">{label}</p>
        <p className="tabular text-xs text-mist-400">{caption}</p>
      </div>
    </Card>
  );
}

function SourceBars({
  sources,
  total,
}: {
  sources: { key: string; label: string; color: string; count: number }[];
  total: number;
}) {
  const active = sources.filter((x) => x.count > 0);
  if (active.length === 0) return <p className="py-6 text-center text-sm text-mist-400">No leads in this period.</p>;
  const max = Math.max(1, ...active.map((x) => x.count));
  return (
    <ul className="space-y-3">
      {active.map((x) => (
        <li key={x.key}>
          <div className="mb-1 flex items-baseline justify-between text-sm">
            <span className="flex items-center gap-2 text-foreground">
              <span className="inline-block size-2.5 rounded-[3px]" style={{ background: x.color }} />
              {x.label}
            </span>
            <span className="tabular text-mist-500">
              {x.count}
              <span className="ml-1.5 text-xs text-mist-400">{Math.round((x.count / total) * 100)}%</span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-pill bg-mist-100">
            <div className="h-full rounded-pill" style={{ width: `${(x.count / max) * 100}%`, background: x.color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const FUNNEL_COLORS: Record<string, string> = {
  new: "#71717a",
  contacted: "#5566B5",
  survey: "#C0822E",
  quoted: "#7C5CBF",
  job: "#3F9B6B",
};

function Funnel({ stats }: { stats: PeriodStats }) {
  const { funnel } = stats;
  const base = Math.max(1, funnel[0].count);
  return (
    <ul className="space-y-2.5">
      {funnel.map((f, i) => {
        const prev = i > 0 ? funnel[i - 1].count : null;
        const step = prev && prev > 0 ? Math.round((f.count / prev) * 100) : null;
        return (
          <li key={f.key}>
            <div className="mb-1 flex items-baseline justify-between text-sm">
              <span className="text-foreground">{f.label}</span>
              <span className="tabular text-mist-500">
                {f.count}
                {i > 0 ? <span className="ml-1.5 text-xs text-mist-400">{f.pct}%</span> : null}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-6 flex-1 overflow-hidden rounded-sm bg-mist-100">
                <div
                  className="h-full rounded-sm"
                  style={{ width: `${(f.count / base) * 100}%`, background: FUNNEL_COLORS[f.key], minWidth: f.count > 0 ? "2px" : 0 }}
                />
              </div>
              {step != null ? (
                <span className="tabular w-10 shrink-0 text-right text-[11px] text-mist-400">→{step}%</span>
              ) : (
                <span className="w-10 shrink-0" />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function WebFunnel({ ph }: { ph: { visited: number; started: number; enquiry: number; callClicks: number; whatsappClicks: number } }) {
  // Two guaranteed-monotonic steps (you can't submit without a pageview). The
  // mid-funnel `lead_start` fires inconsistently on the lead-form-hero LPs (the
  // form IS the hero, so there's no distinct "start"), so it lives in the context
  // line below rather than as a funnel bar that could read as broken.
  const conv = ph.visited > 0 ? Math.round((ph.enquiry / ph.visited) * 100) : 0;
  const drop = ph.visited > 0 ? 100 - conv : 0;
  const steps = [
    { label: "Visited site", count: ph.visited, color: "#71717a" },
    { label: "Submitted enquiry", count: ph.enquiry, color: "#3F9B6B" },
  ];
  const base = Math.max(1, ph.visited);
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-sm text-mist-500">Site → enquiry conversion</span>
        <span className="tabular font-display text-xl font-bold text-foreground">{conv}%</span>
      </div>
      <ul className="space-y-2.5">
        {steps.map((st, i) => (
          <li key={st.label}>
            <div className="mb-1 flex items-baseline justify-between text-sm">
              <span className="text-foreground">{st.label}</span>
              <span className="tabular text-mist-500">{st.count}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-6 flex-1 overflow-hidden rounded-sm bg-mist-100">
                <div
                  className="h-full rounded-sm"
                  style={{ width: `${(st.count / base) * 100}%`, background: st.color, minWidth: st.count > 0 ? "2px" : 0 }}
                />
              </div>
              {i === 1 ? (
                <span className="tabular w-16 shrink-0 text-right text-[11px] text-mm-red">−{drop}% drop</span>
              ) : (
                <span className="w-16 shrink-0" />
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-border pt-3 text-xs text-mist-400">
        <span className="tabular text-foreground">{ph.started}</span> started a quote ·{" "}
        <span className="tabular text-foreground">{ph.callClicks}</span> called ·{" "}
        <span className="tabular text-foreground">{ph.whatsappClicks}</span> WhatsApp
      </p>
    </div>
  );
}

function ActionCard({
  label,
  count,
  href,
  accent,
  empty,
}: {
  label: string;
  count: number;
  href: string;
  accent?: boolean;
  empty: string;
}) {
  const isEmpty = count === 0;
  return (
    <Link href={href} className="focus-ring block rounded-lg">
      <Card className="p-5 transition-colors hover:bg-muted">
        <div className="flex items-start justify-between gap-2">
          <p className="eyebrow">{label}</p>
          <ChevronRight className="size-4 shrink-0 text-mist-300" strokeWidth={1.75} />
        </div>
        {isEmpty ? (
          <p className="mt-2 text-sm text-mist-400">{empty}</p>
        ) : (
          <p className={"mt-1 font-display tabular text-4xl font-bold " + (accent ? "text-mm-red" : "text-foreground")}>
            {count}
          </p>
        )}
      </Card>
    </Link>
  );
}
