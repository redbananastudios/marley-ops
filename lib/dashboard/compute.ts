/**
 * Dashboard compute layer — pure, framework-free. Turns raw lead/quote/appointment
 * rows into per-period stats: leads by source, the cohort conversion funnel
 * (enquiry → contacted → survey → quoted → job) with %s, period-over-period diffs,
 * and current-vs-previous chart buckets. No fetching here; the page passes data in.
 *
 * Cohort model: a period's funnel is computed over the leads that CAME IN during
 * that period (by submitted/created date), then asks how far each has progressed —
 * so "% of leads that booked a survey / became a job" is honest for that intake.
 * Progress is read from concrete signals (a survey appointment exists, a quote
 * exists, a quote was accepted) OR the lead's current status rank, whichever is
 * further — current status alone misses leads that skipped a stage.
 */

import type { WebsiteFunnel } from "@/lib/posthog";
import type { EstimatorStat } from "@/lib/estimator";

export type PeriodKey = "today" | "week" | "month";

export type SourceKey = "google_ads" | "meta" | "organic" | "referral" | "manual";

export interface SourceMeta {
  key: SourceKey;
  label: string;
  color: string;
}

/** Muted categorical palette — distinct but calm, so it sits beside the red accent. */
export const SOURCES: SourceMeta[] = [
  { key: "google_ads", label: "Google Ads", color: "#C0822E" },
  { key: "meta", label: "Meta", color: "#5566B5" },
  { key: "organic", label: "Organic / Direct", color: "#3F9B6B" },
  { key: "referral", label: "Referral", color: "#7C5CBF" },
  { key: "manual", label: "Manual", color: "#71717A" },
];

export interface LeadLite {
  id: string;
  name: string | null;
  status: string;
  entry_channel: string;
  from_postcode: string | null;
  to_postcode: string | null;
  submitted_at: string | null;
  created_at: string | null;
  first_contacted_at: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** % of new leads in this cohort that reached this stage. */
  pct: number;
}

export interface Bucket {
  label: string;
  current: number;
  previous: number;
}

export interface PeriodStats {
  key: PeriodKey;
  label: string;
  /** rolling comparison sublabel, e.g. "vs yesterday" / "vs previous 7 days". */
  vsLabel: string;
  newLeads: number;
  prevNewLeads: number;
  contacted: number;
  surveys: number;
  quoted: number;
  jobs: number;
  wonValue: number;
  leadToSurveyPct: number;
  leadToJobPct: number;
  surveyToJobPct: number;
  /** Google Ads leads in this cohort (for cost-per-lead). */
  paidLeads: number;
  /** won (agreed) revenue from Google Ads leads in this cohort (for ROAS). */
  paidWonValue: number;
  /** Google Ads spend for the period — filled by the page after the Ads API call; null if unavailable. */
  adSpend: number | null;
  sources: { key: SourceKey; label: string; color: string; count: number }[];
  funnel: FunnelStage[];
  topCampaigns: { campaign: string; count: number }[];
  chartLabel: string;
  buckets: Bucket[];
  posthog: WebsiteFunnel | null;
  /** per-estimator visits/won/fee for this period — filled by the page. */
  estimators: EstimatorStat[];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

const STATUS_RANK: Record<string, number> = {
  website_enquiry: 0,
  survey_booked: 1,
  quoted: 2,
  provisional: 3,
  confirmed: 4,
  completed: 5,
  declined: -1,
};

const ts = (l: LeadLite): number => {
  const d = l.submitted_at || l.created_at;
  const n = d ? new Date(d).getTime() : 0;
  return Number.isNaN(n) ? 0 : n;
};

export function classifySource(l: LeadLite): SourceKey {
  if (
    l.gclid ||
    l.gbraid ||
    l.wbraid ||
    /cpc|ppc|paid/i.test(l.utm_medium ?? "") ||
    l.entry_channel === "phone_google"
  )
    return "google_ads";
  if (
    l.fbclid ||
    /facebook|meta|instagram|^fb$|^ig$/i.test(l.utm_source ?? "") ||
    l.entry_channel === "phone_facebook"
  )
    return "meta";
  if (l.entry_channel === "manual") return "manual";
  if (l.entry_channel === "referral" || l.entry_channel === "phone_referral") return "referral";
  return "organic";
}

const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 100) : 0);

export interface ProgressSets {
  /** lead ids with a (non-cancelled) survey appointment */
  surveyed: Set<string>;
  /** lead ids with any quote row */
  quoted: Set<string>;
  /** lead id -> accepted (agreed) value, for won leads */
  won: Map<string, number>;
}

interface WindowDef {
  curFrom: number;
  curTo: number;
  prevFrom: number;
  prevTo: number;
  nBuckets: number;
  bucketMs: number;
  /** start of the first current bucket */
  bucketStart: number;
  chartLabel: string;
  bucketTick: (i: number, startMs: number) => string;
}

function windowFor(key: PeriodKey, now: number): WindowDef {
  const startToday = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  if (key === "today") {
    return {
      curFrom: startToday,
      curTo: now + 1,
      prevFrom: startToday - DAY,
      prevTo: startToday,
      nBuckets: 12,
      bucketMs: 2 * HOUR,
      bucketStart: startToday,
      chartLabel: "Today vs yesterday · by hour",
      bucketTick: (i) => (i % 3 === 0 ? `${i * 2}:00` : ""),
    };
  }
  if (key === "week") {
    const curFrom = startToday - 6 * DAY;
    return {
      curFrom,
      curTo: now + 1,
      prevFrom: curFrom - 7 * DAY,
      prevTo: curFrom,
      nBuckets: 7,
      bucketMs: DAY,
      bucketStart: curFrom,
      chartLabel: "This week vs last week · by day",
      bucketTick: (i, startMs) =>
        new Date(startMs + i * DAY).toLocaleDateString("en-GB", { weekday: "short" }),
    };
  }
  const curFrom = startToday - 29 * DAY;
  return {
    curFrom,
    curTo: now + 1,
    prevFrom: curFrom - 30 * DAY,
    prevTo: curFrom,
    nBuckets: 30,
    bucketMs: DAY,
    bucketStart: curFrom,
    chartLabel: "This month vs last month · by day",
    bucketTick: (i, startMs) =>
      i % 7 === 0 ? new Date(startMs + i * DAY).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "",
  };
}

const LABELS: Record<PeriodKey, { label: string; vsLabel: string }> = {
  today: { label: "Today", vsLabel: "vs yesterday" },
  week: { label: "This week", vsLabel: "vs previous 7 days" },
  month: { label: "This month", vsLabel: "vs previous 30 days" },
};

export function buildPeriodStats(
  key: PeriodKey,
  leads: LeadLite[],
  prog: ProgressSets,
  now: number,
  posthog: WebsiteFunnel | null,
): PeriodStats {
  const w = windowFor(key, now);

  const cohort = leads.filter((l) => ts(l) >= w.curFrom && ts(l) < w.curTo);
  const prevCohort = leads.filter((l) => ts(l) >= w.prevFrom && ts(l) < w.prevTo);

  const reached = (l: LeadLite, target: string): boolean =>
    (STATUS_RANK[l.status] ?? -1) >= (STATUS_RANK[target] ?? 99);

  const isContacted = (l: LeadLite) => l.first_contacted_at != null;
  const isSurveyed = (l: LeadLite) => prog.surveyed.has(l.id) || reached(l, "survey_booked");
  const isQuoted = (l: LeadLite) => prog.quoted.has(l.id) || reached(l, "quoted");
  const isWon = (l: LeadLite) => prog.won.has(l.id) || reached(l, "confirmed");

  const newLeads = cohort.length;
  const contacted = cohort.filter(isContacted).length;
  const surveys = cohort.filter(isSurveyed).length;
  const quoted = cohort.filter(isQuoted).length;
  const jobs = cohort.filter(isWon).length;

  /* sources (current cohort) */
  const srcCount = new Map<SourceKey, number>();
  for (const l of cohort) srcCount.set(classifySource(l), (srcCount.get(classifySource(l)) ?? 0) + 1);
  const sources = SOURCES.map((s) => ({
    key: s.key,
    label: s.label,
    color: s.color,
    count: srcCount.get(s.key) ?? 0,
  }));

  /* top campaigns (current cohort) */
  const campMap = new Map<string, number>();
  for (const l of cohort) if (l.utm_campaign) campMap.set(l.utm_campaign, (campMap.get(l.utm_campaign) ?? 0) + 1);
  const topCampaigns = [...campMap.entries()]
    .map(([campaign, count]) => ({ campaign, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  /* chart buckets */
  const bucketCounts = (from: number, list: LeadLite[]): number[] => {
    const arr = new Array(w.nBuckets).fill(0);
    for (const l of list) {
      const t = ts(l);
      const idx = Math.floor((t - from) / w.bucketMs);
      if (idx >= 0 && idx < w.nBuckets) arr[idx] += 1;
    }
    return arr;
  };
  const cur = bucketCounts(w.bucketStart, cohort);
  const prevAligned = bucketCounts(w.prevFrom, prevCohort);
  const buckets: Bucket[] = cur.map((c, i) => ({
    label: w.bucketTick(i, w.bucketStart),
    current: c,
    previous: prevAligned[i] ?? 0,
  }));

  const wonValue = cohort.reduce((sum, l) => sum + (prog.won.get(l.id) ?? 0), 0);
  const paidLeads = srcCount.get("google_ads") ?? 0;
  const paidWonValue = cohort
    .filter((l) => classifySource(l) === "google_ads")
    .reduce((sum, l) => sum + (prog.won.get(l.id) ?? 0), 0);

  return {
    key,
    label: LABELS[key].label,
    vsLabel: LABELS[key].vsLabel,
    newLeads,
    prevNewLeads: prevCohort.length,
    contacted,
    surveys,
    quoted,
    jobs,
    wonValue,
    leadToSurveyPct: pct(surveys, newLeads),
    leadToJobPct: pct(jobs, newLeads),
    surveyToJobPct: pct(jobs, surveys),
    paidLeads,
    paidWonValue,
    adSpend: null,
    sources,
    funnel: [
      { key: "new", label: "Enquiries", count: newLeads, pct: 100 },
      { key: "contacted", label: "Contacted", count: contacted, pct: pct(contacted, newLeads) },
      { key: "survey", label: "Survey booked", count: surveys, pct: pct(surveys, newLeads) },
      { key: "quoted", label: "Quoted", count: quoted, pct: pct(quoted, newLeads) },
      { key: "job", label: "Jobs won", count: jobs, pct: pct(jobs, newLeads) },
    ],
    topCampaigns,
    chartLabel: w.chartLabel,
    buckets,
    posthog,
    estimators: [],
  };
}

/** Window bounds for the PostHog fetch — must match the cohort current window. */
export function periodWindow(key: PeriodKey, now: number): { from: Date; to: Date } {
  const w = windowFor(key, now);
  return { from: new Date(w.curFrom), to: new Date(w.curTo) };
}
