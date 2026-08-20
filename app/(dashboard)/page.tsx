import { unstable_cache } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { fetchWebsiteFunnel } from "@/lib/posthog";
import { fetchAdSpend } from "@/lib/google-ads";
import {
  buildPeriodStats,
  classifySource,
  isWonQuote,
  periodWindow,
  SOURCES,
  type LeadLite,
  type PeriodKey,
  type PeriodStats,
  type ProgressSets,
} from "@/lib/dashboard/compute";
import { moneyTileCounts } from "@/lib/bookings/queue";
import { loadBookingRows } from "@/lib/bookings/load-signals";
import { aggregateEstimators, type EstimatorVisit } from "@/lib/estimator";
import { vehicleHasExpiryDue } from "@/lib/vehicles";
import { getBusinessSettings } from "@/lib/settings";
import { jobCost, boxesFromItems, commissionCost } from "@/lib/margin";
import type { QuoteBreakdown } from "@/lib/quote/pricing";
import { DashboardView, type DashboardData } from "@/components/dashboard/dashboard-view";
import type { DateAtRiskItem } from "@/components/dashboard/dates-at-risk-card";
import { syncSanityLeads } from "@/lib/sync/sanity-leads";
import { startOfUkDay, UK_TZ } from "@/lib/uk-time";
import { getSessionProfile } from "@/lib/auth";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const PERIOD_KEYS: PeriodKey[] = ["today", "week", "month"];
const sourceLabel = (key: string): string => SOURCES.find((s) => s.key === key)?.label ?? key;

/* PostHog funnel + Google Ads spend are the slow leg of the dashboard (6 external
   API calls, 1-2s combined) and don't need per-click freshness. Cached for 5 min
   so menu navigation back to the dashboard doesn't re-pay them. Both return plain
   numbers, so the JSON round-trip of the data cache is lossless. */
const fetchExternalPanels = unstable_cache(
  async () => {
    const now = Date.now();
    const [ph, spend] = await Promise.all([
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
    return { ph, spend };
  },
  ["dashboard-external-panels"],
  { revalidate: 300 },
);

export default async function DashboardPage() {
  const profile = await getSessionProfile();
  if (profile?.role === "estimator") redirect("/estimator");

  const supabase = await createClient();

  // Keep the panel current: pull any new website leads from Sanity before reading.
  // Incremental (only docs newer than the latest synced lead) so it's fast, and
  // fail-soft so a slow/unreachable Sanity never blocks the dashboard render.
  await syncSanityLeads({ incremental: true }).catch(() => null);

  // Start independent external/attention reads before the all-time KPI scan.
  // They used to sit behind all lead/appointment/quote processing, adding their
  // full network latency to every uncached dashboard render.
  const externalPanelsPromise = fetchExternalPanels();
  const attentionPromise = Promise.all([
    supabase
      .from("vehicles")
      .select("tax_due, mot_due, insurance_renewal, service_due, end_of_term")
      .eq("is_active", true),
    Promise.all([
      // "Unsigned contracts" must only count jobs a signature is actually still
      // wanted for. Legacy iMVE bookings were made under the old terms and never
      // sign a Marley contract (the same suppression the schedule board and crew
      // sheets already apply), and a cancelled booking keeps status='accepted'
      // by design — without these two filters the tile tells crew to collect
      // contracts that must never be collected, and grows forever.
      supabase
        .from("quotes")
        .select("id")
        .eq("status", "accepted")
        .neq("source", "imve")
        .is("booking_cancelled_at", null),
      supabase.from("signatures").select("quote_id").eq("kind", "contract"),
    ]),
    supabase
      .from("claims")
      .select("id", { count: "exact", head: true })
      .in("status", ["open", "assessing", "offer_made"]),
    supabase.from("follow_ups").select("due_at").eq("status", "open"),
    // Refund review queue (Payments Policy v2): rows waiting on a decision or
    // an execute press — the /refunds needs-action pointer.
    supabase.from("refund_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
    // "Dates at risk": commitment unpaid at 7 days out (chase cron stamped
    // date_releasable_at). Joined with the lead's live status so cancelled/
    // completed jobs drop out. Discretion state — nothing releases itself.
    (async (): Promise<DateAtRiskItem[]> => {
      const ukToday = new Date().toLocaleDateString("en-CA", { timeZone: UK_TZ });
      const { data: riskQuotes } = await supabase
        .from("quotes")
        .select("lead_id, quote_ref, customer_name, moving_date, commitment_invoice_amount, date_releasable_at")
        .eq("status", "accepted")
        .not("date_releasable_at", "is", null)
        .is("commitment_paid_at", null)
        .gte("moving_date", ukToday)
        .order("moving_date", { ascending: true });
      const riskLeadIds = [...new Set((riskQuotes ?? []).map((q) => q.lead_id).filter(Boolean))] as string[];
      const { data: riskLeads } = riskLeadIds.length
        ? await supabase.from("leads").select("id, name, status").in("id", riskLeadIds).eq("status", "confirmed")
        : { data: [] as { id: string; name: string | null; status: string }[] };
      const riskLeadById = new Map((riskLeads ?? []).map((l) => [l.id, l]));
      return (riskQuotes ?? [])
        .filter((q) => q.lead_id && riskLeadById.has(q.lead_id))
        .map((q) => ({
          leadId: q.lead_id as string,
          quoteRef: q.quote_ref,
          customerName: q.customer_name ?? riskLeadById.get(q.lead_id as string)?.name ?? null,
          movingDate: q.moving_date,
          amountDue: Number(q.commitment_invoice_amount ?? 0),
          releasableSince: q.date_releasable_at,
        }));
    })(),
    // Money tiles ("Awaiting deposit" + "Balance due") — counted off the SAME
    // classified ledger /bookings and the /payments Due tab render
    // (lib/bookings/load-signals.ts), so the tiles and the queues they link to
    // can never disagree. awaitingDeposit used to count leads.status=
    // 'provisional', which diverged the moment a lead was hand-confirmed with
    // the deposit unpaid (QA-20260820-02); balanceDue counts only balance_due +
    // balance_overdue — money owed NOW, not every deposit-paid booking
    // (far-future all_set bookings owe nothing yet).
    loadBookingRows(supabase).then(({ rows }) => moneyTileCounts(rows)),
  ]);

  // Unbounded, all-time tables → page through fetchAllRows (PostgREST caps a
  // plain select at 1000 rows and would silently corrupt every all-time KPI).
  // leads keeps submitted_at-desc for the "Latest enquiries" slice(0,6) below,
  // with id as a unique tiebreaker so the range() windows never skip/duplicate.
  const [leadsData, apptData, quoteData, { data: profilesData }, settings] =
    await Promise.all([
      fetchAllRows((f, t) =>
        supabase
          .from("leads")
          .select(
            "id, name, status, entry_channel, from_postcode, to_postcode, submitted_at, created_at, first_contacted_at, balance_paid_at, referral_commission, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium, utm_campaign",
          )
          .order("submitted_at", { ascending: false })
          .order("id")
          .range(f, t),
      { strict: true },
      ),
      fetchAllRows((f, t) =>
        supabase.from("appointments").select("id, appt_type, starts_at, status, lead_id, estimator_id").order("id").range(f, t),
      { strict: true },
      ),
      fetchAllRows((f, t) =>
        supabase
          .from("quotes")
          .select("id, status, grand_total, agreed_price, lead_id, breakdown, state_blob, deposit_paid_at, booking_cancelled_at")
          .order("id")
          .range(f, t),
      { strict: true },
      ),
      supabase.from("profiles").select("id, full_name"),
      getBusinessSettings(supabase),
    ]);
  const profileName = new Map((profilesData ?? []).map((p) => [p.id, p.full_name as string]));
  const estimatorFee = settings.estimatorFee;

  const leads = (leadsData ?? []) as LeadLite[];
  const appts = apptData ?? [];
  const quotes = quoteData ?? [];

  // Lead-level 3rd-party referral fees (numeric arrives as a string) — folded
  // into each won job's cost below so margin reflects what the job really made.
  const commissionByLead = new Map(
    (leadsData ?? []).map((l) => [
      l.id as string,
      (l as { referral_commission?: number | string | null }).referral_commission ?? null,
    ]),
  );

  // Server component: a per-request timestamp is correct here (this is not a
  // client render that must stay idempotent across re-renders).
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const startToday = startOfUkDay().getTime();

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
        .filter(isWonQuote)
        .map((q) => [q.lead_id as string, Number(q.agreed_price ?? q.grand_total ?? 0)]),
    ),
    cost: new Map(
      quotes
        .filter(isWonQuote)
        .map((q) => {
          const b = (q.breakdown ?? {}) as Partial<QuoteBreakdown>;
          const blob = (q.state_blob as { items?: Record<string, number>; job?: { days?: number } } | null) ?? null;
          const c = jobCost(
            {
              vehicle: b.vehicle ?? "1luton",
              sevenFiveT: b.sevenFiveT ?? (b.has75T ? 1 : 0),
              totalMiles: Number(b.totalMiles ?? 0),
              boxes: boxesFromItems(blob?.items),
              days: Math.max(1, Number(blob?.job?.days ?? 1)),
            },
            settings,
          );
          // A lead-level 3rd-party referral fee is a real cost of winning this
          // job — fold it in so the profit/margin KPI shows what's actually made.
          return [q.lead_id as string, c.total + commissionCost(commissionByLead.get(q.lead_id as string))];
        }),
    ),
  };

  /* PostHog website funnel + Google Ads spend — cached (see fetchExternalPanels) */
  const { ph: phResults, spend: spendResults } = await externalPanelsPromise;

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
    periods[k].estimators = aggregateEstimators(visits, estimatorFee);
  }

  /* needs-action (now) */
  const statusCounts = new Map<string, number>();
  for (const l of leads) statusCounts.set(l.status, (statusCounts.get(l.status) ?? 0) + 1);
  const [
    fleetResult,
    [acceptedResult, signedResult],
    claimsResult,
    followUpsResult,
    refundQueueResult,
    datesAtRisk,
    moneyTiles,
  ] = await attentionPromise;
  const signedIds = new Set((signedResult.data ?? []).map((signature) => signature.quote_id));
  let followUpsOverdue = 0;
  let followUpsDueToday = 0;
  for (const followUp of followUpsResult.data ?? []) {
    const time = new Date(followUp.due_at).getTime();
    if (time < startToday) followUpsOverdue++;
    else if (time < startToday + DAY) followUpsDueToday++;
  }
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
    // Money pipeline — both counts come off the classified /bookings ledger
    // (see moneyTiles above), never a lead-status proxy.
    awaitingDeposit: moneyTiles.awaitingDeposit,
    balanceDue: moneyTiles.balanceDue,
    // Fleet compliance: active vehicles with any expiry (MOT/tax/insurance/
    // service/lease) due ≤30d or overdue — the full fleet-reminder scope.
    fleetDocsDue: (fleetResult.data ?? []).filter((vehicle) => vehicleHasExpiryDue(vehicle)).length,
    // Accepted quotes with no contract signature — crew must collect on arrival.
    unsignedContracts: (acceptedResult.data ?? []).filter((quote) => !signedIds.has(quote.id)).length,
    openClaims: claimsResult.count ?? 0,
    // Refund-queue rows waiting on a decision/execution (Payments Policy v2).
    refundsWaiting: refundQueueResult.count ?? 0,
    followUpsOverdue,
    followUpsDueToday,
  };

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
    needsAction,
    datesAtRisk,
    recent,
    recentHeading: todays.length ? "Today's enquiries" : "Latest enquiries",
    dateLabel: new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: UK_TZ }),
  };

  return <DashboardView data={data} />;
}
