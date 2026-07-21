import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { SyncLeadsButton } from "@/components/sync-leads-button";
import { Button } from "@/components/ui/button";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { LeadsBoard, type LeadCard } from "@/components/leads/leads-board";
import { syncSanityLeads } from "@/lib/sync/sanity-leads";
import { ownerEstimatorId } from "@/lib/leads/ownership";
import { startOfUkDay } from "@/lib/uk-time";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

export const dynamic = "force-dynamic";

type SearchParams = { status?: string };

const DAY = 86_400_000;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const initialStatus = sp.status?.trim() || undefined;

  // Always current: pull any new website leads from Sanity before reading.
  // Incremental + fail-soft so a slow/unreachable Sanity never blocks the page.
  await syncSanityLeads({ incremental: true }).catch(() => null);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Unbounded tables go through fetchAllRows (PostgREST truncates at 1000 rows);
  // the open no-reply set is small by nature so a plain select is fine.
  const [leads, quoteData, apptData, { data: retryData }] = await Promise.all([
    fetchAllRows((f, t) =>
      supabase
        .from("leads")
        .select(
          "id, name, status, entry_channel, from_postcode, to_postcode, property_size, submitted_at, created_at, first_contacted_at, phone, email, estimator_id, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium, utm_campaign",
        )
        .order("submitted_at", { ascending: false })
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("quotes").select("lead_id, quote_ref, grand_total, agreed_price, status, created_at").order("id").range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("appointments").select("lead_id, appt_type, starts_at, status, estimator_id").order("id").range(f, t),
    ),
    // Open "no reply" retries — surfaces as an amber badge + the Awaiting-retry filter.
    supabase.from("follow_ups").select("lead_id, due_at, attempt_count").eq("reason", "no_answer").eq("status", "open"),
  ]);

  /* per-lead best value: accepted agreed price, else latest quoted total */
  const valueMap = new Map<string, {
    accepted: number | null;
    acceptedRef: string | null;
    latest: number | null;
    latestRef: string | null;
    latestAt: number;
  }>();
  for (const q of quoteData) {
    if (!q.lead_id) continue;
    const cur = valueMap.get(q.lead_id) ?? {
      accepted: null,
      acceptedRef: null,
      latest: null,
      latestRef: null,
      latestAt: 0,
    };
    if (q.status === "accepted") {
      cur.accepted = Number(q.agreed_price ?? q.grand_total ?? 0);
      cur.acceptedRef = q.quote_ref;
    }
    const at = new Date(q.created_at ?? 0).getTime();
    if (at >= cur.latestAt && q.grand_total != null) {
      cur.latest = Number(q.grand_total);
      cur.latestRef = q.quote_ref;
      cur.latestAt = at;
    }
    valueMap.set(q.lead_id, cur);
  }

  /* survey-derived estimator: whoever is assigned the booked survey appointment.
     Combined with the lead's explicit estimator_id via ownerEstimatorId() below —
     the SAME rule the estimator "My day" cockpit uses, so "Mine" and "My day"
     never disagree (a pre-survey assigned lead now shows in both). */
  const surveyEstimator = new Map<string, string>();
  for (const a of apptData) {
    if (a.appt_type !== "survey" || a.status === "cancelled" || !a.lead_id || !a.estimator_id) continue;
    if (!surveyEstimator.has(a.lead_id)) surveyEstimator.set(a.lead_id, a.estimator_id);
  }

  /* leads with an upcoming (non-cancelled) survey appointment — keep the soonest time
     so the card can show WHEN the survey is, not just that one exists */
  const startToday = startOfUkDay().getTime();
  const upcomingSurveyAt = new Map<string, string>();
  for (const a of apptData) {
    if (
      a.appt_type !== "survey" ||
      a.status === "cancelled" ||
      !a.lead_id ||
      !a.starts_at ||
      new Date(a.starts_at).getTime() < startToday - DAY
    )
      continue;
    const cur = upcomingSurveyAt.get(a.lead_id);
    if (!cur || new Date(a.starts_at).getTime() < new Date(cur).getTime()) upcomingSurveyAt.set(a.lead_id, a.starts_at);
  }

  /* open no-reply retry per lead (one open no_answer follow-up max by design) */
  const retryMap = new Map<string, { dueAt: string | null; attempts: number }>();
  for (const r of retryData ?? []) {
    if (r.lead_id) retryMap.set(r.lead_id, { dueAt: r.due_at, attempts: r.attempt_count ?? 0 });
  }

  const cards: LeadCard[] = leads.map((l) => {
    const v = valueMap.get(l.id);
    return {
      id: l.id,
      name: l.name,
      status: l.status,
      entry_channel: l.entry_channel,
      from_postcode: l.from_postcode,
      to_postcode: l.to_postcode,
      property_size: l.property_size,
      submitted_at: l.submitted_at,
      created_at: l.created_at,
      first_contacted_at: l.first_contacted_at,
      phone: l.phone,
      email: l.email,
      estimator_id: ownerEstimatorId(l.estimator_id, surveyEstimator.get(l.id)),
      source: classifySource(l as LeadLite),
      value: v ? (v.accepted ?? v.latest) : null,
      reference: v ? (v.acceptedRef ?? v.latestRef) : null,
      surveyDue: upcomingSurveyAt.has(l.id) || l.status === "survey_booked",
      surveyAt: upcomingSurveyAt.get(l.id) ?? null,
      retry: retryMap.get(l.id) ?? null,
    };
  });

  return (
    <main className="min-h-full flex-1 bg-[#F7F8FA] p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Leads">
        <SyncLeadsButton />
        <Button asChild className="bg-[#C03838] hover:bg-[#A8221C]">
          <Link href="/leads/new">
            <Plus strokeWidth={1.75} />
            Add lead
          </Link>
        </Button>
      </PageHeader>

      <LeadsBoard leads={cards} meId={user?.id ?? null} initialStatus={initialStatus} />
    </main>
  );
}
