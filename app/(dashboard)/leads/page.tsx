import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { SyncLeadsButton } from "@/components/sync-leads-button";
import { Button } from "@/components/ui/button";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { LeadsBoard, type LeadCard } from "@/components/leads/leads-board";
import { syncSanityLeads } from "@/lib/sync/sanity-leads";

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

  const [{ data: leadsData }, { data: quoteData }, { data: apptData }] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "id, name, status, entry_channel, from_postcode, to_postcode, submitted_at, created_at, first_contacted_at, phone, email, estimator_id, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium, utm_campaign",
      )
      .order("submitted_at", { ascending: false }),
    supabase.from("quotes").select("lead_id, grand_total, agreed_price, status, created_at"),
    supabase.from("appointments").select("lead_id, appt_type, starts_at, status, estimator_id"),
  ]);

  const leads = leadsData ?? [];

  /* per-lead best value: accepted agreed price, else latest quoted total */
  const valueMap = new Map<string, { accepted: number | null; latest: number | null; latestAt: number }>();
  for (const q of quoteData ?? []) {
    if (!q.lead_id) continue;
    const cur = valueMap.get(q.lead_id) ?? { accepted: null, latest: null, latestAt: 0 };
    if (q.status === "accepted") cur.accepted = Number(q.agreed_price ?? q.grand_total ?? 0);
    const at = new Date(q.created_at ?? 0).getTime();
    if (at >= cur.latestAt && q.grand_total != null) {
      cur.latest = Number(q.grand_total);
      cur.latestAt = at;
    }
    valueMap.set(q.lead_id, cur);
  }

  /* estimator is survey-derived: whoever is assigned the booked survey owns the lead.
     null until a survey exists — there's no estimator at the enquiry stage. */
  const surveyEstimator = new Map<string, string>();
  for (const a of apptData ?? []) {
    if (a.appt_type !== "survey" || a.status === "cancelled" || !a.lead_id || !a.estimator_id) continue;
    if (!surveyEstimator.has(a.lead_id)) surveyEstimator.set(a.lead_id, a.estimator_id);
  }

  /* leads with an upcoming (non-cancelled) survey appointment */
  const startToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
  const upcomingSurvey = new Set(
    (apptData ?? [])
      .filter(
        (a) =>
          a.appt_type === "survey" &&
          a.status !== "cancelled" &&
          a.lead_id &&
          a.starts_at &&
          new Date(a.starts_at).getTime() >= startToday - DAY,
      )
      .map((a) => a.lead_id as string),
  );

  const cards: LeadCard[] = leads.map((l) => {
    const v = valueMap.get(l.id);
    return {
      id: l.id,
      name: l.name,
      status: l.status,
      entry_channel: l.entry_channel,
      from_postcode: l.from_postcode,
      to_postcode: l.to_postcode,
      submitted_at: l.submitted_at,
      created_at: l.created_at,
      first_contacted_at: l.first_contacted_at,
      phone: l.phone,
      email: l.email,
      estimator_id: surveyEstimator.get(l.id) ?? null,
      source: classifySource(l as LeadLite),
      value: v ? (v.accepted ?? v.latest) : null,
      surveyDue: upcomingSurvey.has(l.id) || l.status === "survey_booked",
    };
  });

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Leads">
        <SyncLeadsButton />
        <Button asChild>
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
