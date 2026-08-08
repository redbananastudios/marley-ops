import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { getBusinessSettings } from "@/lib/settings";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { PageHeader } from "@/components/page-header";
import {
  SchedulerView,
  type SchedulerEvent,
} from "@/components/schedule/scheduler-view";

export const dynamic = "force-dynamic";

export default async function SurveysSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string; new?: string }>;
}) {
  const { leadId, new: createNew } = await searchParams;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

  // appts + leads are unbounded and grow for the life of the business → page
  // through fetchAllRows (a plain select truncates at PostgREST's 1000-row cap;
  // the lead picker below reads this array directly, so past 1000 rows recent
  // leads would silently vanish from it). id is a unique tiebreaker so the
  // display order (starts_at / created_at) pages without skips or duplicates.
  const [appts, leads, { data: estimators }] = await Promise.all([
    fetchAllRows((f, t) =>
      sb
        .from("appointments")
        .select(
          "id,title,starts_at,ends_at,all_day,appt_type,status,location,lead_id,estimator_id,notes",
        )
        .eq("appt_type", "survey")
        .order("starts_at", { ascending: true })
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      sb
        .from("leads")
        .select(
          "id,client_id,name,phone,email,from_postcode,from_address,to_postcode,to_address,property_size,notes,entry_channel,gclid,gbraid,wbraid,fbclid,utm_source,utm_medium,utm_campaign",
        )
        .order("created_at", { ascending: false })
        .order("id")
        .range(f, t),
    ),
    // Only people who can actually DO a survey. The list used to include crew:
    // assigning one meant they never saw the visit (/my-jobs is driven by crew
    // assignments, not estimator_id), could never bill it, and the customer had
    // already been emailed their name as the person coming.
    sb
      .from("profiles")
      .select("id,full_name")
      .eq("active", true)
      .in("role", ["estimator", "admin"])
      .order("full_name", { ascending: true }),
  ]);

  const { baseLocation } = await getBusinessSettings(sb);

  // Per-lead survey estimator (so a removal can inherit it read-only).
  const surveyEst = new Map<string, string>();
  for (const a of appts ?? []) {
    if (a.appt_type === "survey" && a.status !== "cancelled" && a.lead_id && a.estimator_id && !surveyEst.has(a.lead_id))
      surveyEst.set(a.lead_id, a.estimator_id);
  }
  const leadOptions = (leads ?? []).map(({ notes, ...l }) => ({
    ...l,
    lead_notes: notes,
    source: classifySource(l as unknown as LeadLite),
    surveyEstimatorId: surveyEst.get(l.id) ?? null,
  }));

  // Bare clients (no enquiry yet — usually phone callers added via Clients) are
  // bookable too: picking one opens the enquiry server-side at booking time.
  const clientIdsWithLeads = new Set((leads ?? []).map((l) => (l as { client_id?: string | null }).client_id).filter(Boolean));
  const { data: bareClients } = await sb
    .from("clients")
    .select("id, display_name, email, phone_raw, phone_e164, postcode_home, address_line1, town")
    .is("merged_into_id", null)
    .eq("is_active", true);
  const clientOptions = (bareClients ?? [])
    .filter((c) => !clientIdsWithLeads.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.display_name,
      phone: c.phone_raw ?? c.phone_e164,
      email: c.email,
      from_postcode: c.postcode_home,
      from_address: [c.address_line1, c.town].filter(Boolean).join(", ") || null,
      to_postcode: null,
      to_address: null,
      property_size: null,
      lead_notes: null,
      source: "manual" as const,
      surveyEstimatorId: null,
      isClient: true,
    }));

  // Booked from a lead ("Book survey") — auto-open the dialog prefilled with that
  // lead + its pickup address as the location.
  let presetLocation: string | null = null;
  if (leadId) {
    const { data: lead } = await sb
      .from("leads")
      .select("from_address, from_postcode")
      .eq("id", leadId)
      .single();
    presetLocation = lead?.from_address || lead?.from_postcode || null;
  }

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Schedule" title="Surveys" />
      <SchedulerView
        view="survey"
        events={(appts ?? []) as SchedulerEvent[]}
        leads={[...leadOptions, ...clientOptions]}
        estimators={(estimators ?? []) as { id: string; full_name: string }[]}
        defaultEstimatorId={user?.id ?? null}
        presetLeadId={leadId ?? null}
        presetLocation={presetLocation}
        openOnLoad={createNew === "1"}
        baseLocation={baseLocation}
      />
    </main>
  );
}
