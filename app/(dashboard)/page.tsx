import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, ChevronRight, Minus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { LeadStatusBadge } from "@/components/lead-status-badge";

export const dynamic = "force-dynamic";

/* ----------------------------- types + helpers ----------------------------- */

type LeadRow = {
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
};

const DAY = 86_400_000;

const ts = (l: LeadRow): number => {
  const d = l.submitted_at || l.created_at;
  const n = d ? new Date(d).getTime() : 0;
  return Number.isNaN(n) ? 0 : n;
};

/** First-touch source bucket from click-IDs → utm → entry channel. */
type Source = "Google Ads" | "Meta" | "Referral" | "Manual" | "Organic / Direct";
function classifySource(l: LeadRow): Source {
  if (l.gclid || l.gbraid || l.wbraid || /cpc|ppc|paid/i.test(l.utm_medium ?? "") || l.entry_channel === "phone_google")
    return "Google Ads";
  if (l.fbclid || /facebook|meta|instagram|^fb$|^ig$/i.test(l.utm_source ?? "") || l.entry_channel === "phone_facebook")
    return "Meta";
  if (l.entry_channel === "manual") return "Manual";
  if (l.entry_channel === "referral" || l.entry_channel === "phone_referral") return "Referral";
  return "Organic / Direct";
}

const SOURCE_ORDER: Source[] = ["Google Ads", "Meta", "Organic / Direct", "Referral", "Manual"];

const PIPELINE: { key: string; label: string }[] = [
  { key: "website_enquiry", label: "Enquiry" },
  { key: "survey_booked", label: "Survey booked" },
  { key: "quoted", label: "Quoted" },
  { key: "provisional", label: "Provisional" },
  { key: "confirmed", label: "Confirmed" },
  { key: "completed", label: "Completed" },
];

const gbp = (n: number): string =>
  "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

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

function srcLabel(l: LeadRow): string {
  return classifySource(l);
}

function fmtDuration(mins: number | null): string {
  if (mins == null) return "—";
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = mins / 60;
  if (h < 24) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/* --------------------------------- page ----------------------------------- */

export default async function DashboardPage() {
  const supabase = await createClient();

  const [{ data: leadsData }, { data: apptData }, { data: quoteData }] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "id, name, status, entry_channel, from_postcode, to_postcode, submitted_at, created_at, first_contacted_at, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium, utm_campaign",
      )
      .order("submitted_at", { ascending: false }),
    supabase.from("appointments").select("id, appt_type, starts_at, status"),
    supabase.from("quotes").select("id, status, grand_total, agreed_price"),
  ]);

  const leads = (leadsData ?? []) as LeadRow[];
  const appts = apptData ?? [];
  const quotes = quoteData ?? [];

  const now = Date.now();
  const startToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();

  /* volume windows (rolling, so deltas compare like-for-like) */
  const inWin = (from: number, to: number) => leads.filter((l) => ts(l) >= from && ts(l) < to).length;
  const todayCount = leads.filter((l) => ts(l) >= startToday).length;
  const last7 = inWin(now - 7 * DAY, now + DAY);
  const prev7 = inWin(now - 14 * DAY, now - 7 * DAY);
  const last30 = inWin(now - 30 * DAY, now + DAY);
  const prev30 = inWin(now - 60 * DAY, now - 30 * DAY);

  /* sources + campaigns (last 30 days) */
  const monthLeads = leads.filter((l) => ts(l) >= now - 30 * DAY);
  const sourceCounts = new Map<Source, number>();
  for (const l of monthLeads) sourceCounts.set(classifySource(l), (sourceCounts.get(classifySource(l)) ?? 0) + 1);
  const sources = SOURCE_ORDER.map((s) => ({ source: s, count: sourceCounts.get(s) ?? 0 })).filter((s) => s.count > 0);
  const sourceMax = Math.max(1, ...sources.map((s) => s.count));

  const campaignCounts = new Map<string, number>();
  for (const l of monthLeads) {
    if (l.utm_campaign) campaignCounts.set(l.utm_campaign, (campaignCounts.get(l.utm_campaign) ?? 0) + 1);
  }
  const campaigns = [...campaignCounts.entries()]
    .map(([campaign, count]) => ({ campaign, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  /* pipeline (current state, all leads) */
  const statusCounts = new Map<string, number>();
  for (const l of leads) statusCounts.set(l.status, (statusCounts.get(l.status) ?? 0) + 1);
  const pipeline = PIPELINE.map((s) => ({ ...s, count: statusCounts.get(s.key) ?? 0 }));
  const pipelineMax = Math.max(1, ...pipeline.map((s) => s.count));
  const declined = statusCounts.get("declined") ?? 0;

  /* needs action */
  const newToAction = statusCounts.get("website_enquiry") ?? 0;
  const surveysToday = appts.filter(
    (a) =>
      a.appt_type === "survey" &&
      a.status !== "cancelled" &&
      a.starts_at &&
      new Date(a.starts_at).getTime() >= startToday &&
      new Date(a.starts_at).getTime() < startToday + DAY,
  ).length;
  const quotesAwaiting = quotes.filter((q) => q.status === "sent").length;

  /* won revenue = agreed price on accepted quotes (falls back to quoted total) */
  const confirmedValue = quotes
    .filter((q) => q.status === "accepted")
    .reduce((sum, q) => sum + Number(q.agreed_price ?? q.grand_total ?? 0), 0);

  /* median response time (submitted -> first contacted) */
  const respMins = leads
    .map((l) => {
      const start = l.submitted_at || l.created_at;
      if (!l.first_contacted_at || !start) return null;
      const m = (new Date(l.first_contacted_at).getTime() - new Date(start).getTime()) / 60000;
      return Number.isFinite(m) && m >= 0 ? m : null;
    })
    .filter((m): m is number => m != null)
    .sort((a, b) => a - b);
  const medianResp = respMins.length ? respMins[Math.floor(respMins.length / 2)] : null;

  /* 14-day trend */
  const trend: { d: number; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const from = startToday - i * DAY;
    trend.push({ d: from, count: leads.filter((l) => ts(l) >= from && ts(l) < from + DAY).length });
  }
  const trendMax = Math.max(1, ...trend.map((t) => t.count));

  /* recent — today's, falling back to the latest few */
  const todays = leads.filter((l) => ts(l) >= startToday);
  const recent = (todays.length ? todays : leads).slice(0, 5);
  const recentHeading = todays.length ? "Today's enquiries" : "Latest enquiries";

  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <main className="flex-1 space-y-6 p-6 md:p-8">
      <header>
        <p className="eyebrow">{today}</p>
        <h1 className="font-display text-3xl text-foreground">Dashboard</h1>
      </header>

      {/* volume + response pulse */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <VolumeCard label="New today" value={todayCount} />
        <VolumeCard label="This week" value={last7} delta={last7 - prev7} sub="vs prev 7 days" />
        <VolumeCard label="This month" value={last30} delta={last30 - prev30} sub="vs prev 30 days" />
        <Card className="p-5">
          <p className="eyebrow">Avg response</p>
          <p className="mt-1 font-display tabular text-4xl font-bold text-foreground">
            {fmtDuration(medianResp)}
          </p>
          <p className="mt-1 text-xs text-mist-400">
            {medianResp == null ? "no leads actioned yet" : "median to first contact"}
          </p>
        </Card>
      </section>

      {/* needs action */}
      <section>
        <p className="eyebrow mb-2">Needs action</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <ActionCard
            label="New enquiries to action"
            count={newToAction}
            href="/leads?status=website_enquiry"
            accent
            empty="All enquiries triaged"
          />
          <ActionCard
            label="Surveys today"
            count={surveysToday}
            href="/schedule/surveys"
            empty="No surveys today"
          />
          <ActionCard
            label="Quotes awaiting reply"
            count={quotesAwaiting}
            href="/quotes"
            empty="No quotes pending"
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* lead sources */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="eyebrow">Where leads come from</p>
            <span className="text-xs text-mist-400">last 30 days</span>
          </div>
          {sources.length === 0 ? (
            <p className="py-6 text-center text-sm text-mist-400">No leads in the last 30 days.</p>
          ) : (
            <ul className="space-y-3">
              {sources.map((s) => (
                <li key={s.source}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span className="text-foreground">{s.source}</span>
                    <span className="tabular text-mist-500">
                      {s.count}
                      <span className="ml-1.5 text-xs text-mist-400">
                        {Math.round((s.count / monthLeads.length) * 100)}%
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-pill bg-mist-100">
                    <div
                      className="h-full rounded-pill bg-charcoal"
                      style={{ width: `${(s.count / sourceMax) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {campaigns.length > 0 ? (
            <div className="mt-5 border-t border-border pt-4">
              <p className="eyebrow mb-2">Top Google Ads campaigns</p>
              <ul className="space-y-1.5">
                {campaigns.map((c) => (
                  <li key={c.campaign} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-mist-500">{c.campaign}</span>
                    <span className="tabular shrink-0 text-foreground">{c.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        {/* pipeline */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="eyebrow">Pipeline</p>
            {declined > 0 ? (
              <span className="text-xs text-mist-400">{declined} declined</span>
            ) : null}
          </div>
          <ul className="space-y-3">
            {pipeline.map((s) => (
              <li key={s.key}>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="text-foreground">{s.label}</span>
                  <span className="tabular text-mist-500">{s.count}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-pill bg-mist-100">
                  <div
                    className="h-full rounded-pill bg-mm-red/70"
                    style={{ width: `${(s.count / pipelineMax) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
          {confirmedValue > 0 ? (
            <div className="mt-5 flex items-baseline justify-between border-t border-border pt-4">
              <span className="text-sm text-mist-500">Won this period</span>
              <span className="tabular font-display text-lg font-bold text-foreground">{gbp(confirmedValue)}</span>
            </div>
          ) : null}
        </Card>
      </div>

      {/* 14-day trend */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <p className="eyebrow">New leads · last 14 days</p>
          <span className="tabular text-xs text-mist-400">
            {trend.reduce((s, t) => s + t.count, 0)} total
          </span>
        </div>
        <div className="flex h-16 items-end gap-1">
          {trend.map((t) => (
            <div key={t.d} className="group flex flex-1 flex-col items-center justify-end gap-1">
              <div
                className="w-full rounded-t-[3px] bg-charcoal/80"
                style={{ height: `${t.count === 0 ? 2 : Math.max(6, (t.count / trendMax) * 52)}px` }}
                title={`${new Date(t.d).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: ${t.count}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-mist-400">
          <span>{new Date(trend[0].d).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
          <span>Today</span>
        </div>
      </Card>

      {/* recent enquiries */}
      <Card className="p-0">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="font-display text-lg text-foreground">{recentHeading}</h2>
          <Link
            href="/leads"
            className="focus-ring rounded-sm text-sm text-mm-red hover:underline"
          >
            View all
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-mist-400">No leads yet.</p>
        ) : (
          <ul className="divide-y">
            {recent.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/leads/${r.id}`}
                  className="focus-ring flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{r.name ?? "—"}</p>
                    <p className="truncate text-xs text-mist-400">
                      {srcLabel(r)} · {timeAgo(r.submitted_at || r.created_at)}
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

/* ------------------------------ small cards -------------------------------- */

function VolumeCard({
  label,
  value,
  delta,
  sub,
}: {
  label: string;
  value: number;
  delta?: number;
  sub?: string;
}) {
  return (
    <Card className="p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-1 font-display tabular text-4xl font-bold text-foreground">{value}</p>
      {delta !== undefined ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-mist-400">
          {delta > 0 ? (
            <ArrowUpRight className="size-3.5 text-success" strokeWidth={2} />
          ) : delta < 0 ? (
            <ArrowDownRight className="size-3.5 text-mist-500" strokeWidth={2} />
          ) : (
            <Minus className="size-3.5 text-mist-400" strokeWidth={2} />
          )}
          <span className="tabular">
            {delta > 0 ? "+" : ""}
            {delta}
          </span>
          {sub ? <span>· {sub}</span> : null}
        </p>
      ) : null}
    </Card>
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
    <Link href={href} className="focus-ring block rounded-md">
      <Card className="p-5 transition-colors hover:bg-muted">
        <div className="flex items-start justify-between gap-2">
          <p className="eyebrow">{label}</p>
          <ChevronRight className="size-4 shrink-0 text-mist-300" strokeWidth={1.75} />
        </div>
        {isEmpty ? (
          <p className="mt-2 text-sm text-mist-400">{empty}</p>
        ) : (
          <p
            className={
              "mt-1 font-display tabular text-4xl font-bold " +
              (accent ? "text-mm-red" : "text-foreground")
            }
          >
            {count}
          </p>
        )}
      </Card>
    </Link>
  );
}
