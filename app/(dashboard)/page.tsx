import { createClient } from "@/lib/supabase/server";
import { fetchWebsiteFunnel } from "@/lib/posthog";
import { fetchAdSpend } from "@/lib/google-ads";
import {
  buildPeriodStats,
  classifySource,
  periodWindow,
  SOURCES,
  type LeadLite,
  type PeriodKey,
  type PeriodStats,
  type ProgressSets,
} from "@/lib/dashboard/compute";
import { aggregateEstimators, type EstimatorVisit } from "@/lib/estimator";
import { DashboardView, type DashboardData } from "@/components/dashboard/dashboard-view";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const PERIOD_KEYS: PeriodKey[] = ["today", "week", "month"];
const sourceLabel = (key: string): string => SOURCES.find((s) => s.key === key)?.label ?? key;

export default async function DashboardPage() {
  const supabase = await createClient();

  const [{ data: leadsData }, { data: apptData }, { data: quoteData }] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "id, name, status, entry_channel, from_postcode, to_postcode, submitted_at, created_at, first_contacted_at, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium, utm_campaign",
      )
      .order("submitted_at", { ascending: false }),
    supabase.from("appointments").select("id, appt_type, starts_at, status, lead_id, estimator_id"),
    supabase.from("quotes").select("id, status, grand_total, agreed_price, lead_id"),
  ]);

  const { data: profilesData } = await supabase.from("profiles").select("id, full_name");
  const profileName = new Map((profilesData ?? []).map((p) => [p.id, p.full_name as string]));

  const leads = (leadsData ?? []) as LeadLite[];
  const appts = apptData ?? [];
  const quotes = quoteData ?? [];

  const now = Date.now();
  const startToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();

  /* progress signals — concrete history, not just current status */
  const prog: ProgressSets = {
    surveyed: new Set(
      appts
        .filter((a) => a.appt_type === "survey" && a.status !== "cancelled" && a.lead_id)
        .map((a) => a.lead_id as string),
    ),
    quoted: new Set(quotes.filter((q) => q.lead_id).map((q) => q.lead_id as string)),
    won: new Map(
      quotes
        .filter((q) => q.status === "accepted" && q.lead_id)
        .map((q) => [q.lead_id as string, Number(q.agreed_price ?? q.grand_total ?? 0)]),
    ),
  };

  /* PostHog website funnel + Google Ads spend — one window per period, all parallel, fail-soft */
  const [phResults, spendResults] = await Promise.all([
    Promise.all(
      PERIOD_KEYS.map((k) => {
        const { from, to } = periodWindow(k, now);
        return fetchWebsiteFunnel(from, to).catch(() => null);
      }),
    ),
    Promise.all(
      PERIOD_KEYS.map((k) => {
        const { from, to } = periodWindow(k, now);
        return fetchAdSpend(from, to).catch(() => null);
      }),
    ),
  ]);

  const periods = Object.fromEntries(
    PERIOD_KEYS.map((k, i) => {
      const stats = buildPeriodStats(k, leads, prog, now, phResults[i]);
      stats.adSpend = spendResults[i] ? spendResults[i]!.costGbp : null;
      return [k, stats];
    }),
  ) as Record<PeriodKey, PeriodStats>;

  /* estimator performance per period — attended (completed) survey visits */
  const leadName = new Map(leads.map((l) => [l.id, l.name ?? "—"]));
  const wonLeadIds = new Set<string>(prog.won.keys());
  for (const l of leads) if (l.status === "confirmed" || l.status === "completed") wonLeadIds.add(l.id);
  const completedSurveys = appts.filter((a) => a.appt_type === "survey" && a.status === "completed" && a.estimator_id);
  for (const k of PERIOD_KEYS) {
    const { from, to } = periodWindow(k, now);
    const f = from.getTime();
    const t = to.getTime();
    const visits: EstimatorVisit[] = completedSurveys
      .filter((a) => {
        const ts = a.starts_at ? new Date(a.starts_at).getTime() : 0;
        return ts >= f && ts < t;
      })
      .map((a) => ({
        apptId: a.id,
        estimatorId: a.estimator_id as string,
        estimatorName: profileName.get(a.estimator_id as string) ?? "Unknown",
        leadId: a.lead_id,
        customer: a.lead_id ? leadName.get(a.lead_id) ?? "—" : "—",
        date: a.starts_at,
        won: a.lead_id ? wonLeadIds.has(a.lead_id) : false,
        value: a.lead_id ? prog.won.get(a.lead_id) ?? null : null,
      }));
    periods[k].estimators = aggregateEstimators(visits);
  }

  /* needs-action (now) */
  const statusCounts = new Map<string, number>();
  for (const l of leads) statusCounts.set(l.status, (statusCounts.get(l.status) ?? 0) + 1);
  const needsAction = {
    newToAction: statusCounts.get("website_enquiry") ?? 0,
    surveysToday: appts.filter(
      (a) =>
        a.appt_type === "survey" &&
        a.status !== "cancelled" &&
        a.starts_at &&
        new Date(a.starts_at).getTime() >= startToday &&
        new Date(a.starts_at).getTime() < startToday + DAY,
    ).length,
    quotesAwaiting: quotes.filter((q) => q.status === "sent").length,
  };

  /* median first-response (all-time pulse) */
  const respMins = leads
    .map((l) => {
      const start = l.submitted_at || l.created_at;
      if (!l.first_contacted_at || !start) return null;
      const m = (new Date(l.first_contacted_at).getTime() - new Date(start).getTime()) / 60000;
      return Number.isFinite(m) && m >= 0 ? m : null;
    })
    .filter((m): m is number => m != null)
    .sort((a, b) => a - b);
  const medianRespMins = respMins.length ? respMins[Math.floor(respMins.length / 2)] : null;

  /* recent — today's, else latest few */
  const tsOf = (l: LeadLite) => new Date(l.submitted_at || l.created_at || 0).getTime();
  const todays = leads.filter((l) => tsOf(l) >= startToday);
  const recentSrc = (todays.length ? todays : leads).slice(0, 6);
  const recent = recentSrc.map((l) => ({
    id: l.id,
    name: l.name,
    status: l.status,
    source: sourceLabel(classifySource(l)),
    when: l.submitted_at || l.created_at,
  }));

  const data: DashboardData = {
    periods,
    medianRespMins,
    needsAction,
    recent,
    recentHeading: todays.length ? "Today's enquiries" : "Latest enquiries",
    dateLabel: new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
  };

  return <DashboardView data={data} />;
}
