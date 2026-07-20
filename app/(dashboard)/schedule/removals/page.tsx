import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { PageHeader } from "@/components/page-header";
import {
  SchedulerView,
  type SchedulerEvent,
} from "@/components/schedule/scheduler-view";

export const dynamic = "force-dynamic";

export default async function RemovalsSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const { leadId } = await searchParams;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

  // Fetch removals + surveys both: surveys can be overlaid via the "Show surveys"
  // toggle so a survey-vs-move clash is visible without a separate Overlap page.
  const [appts, leads, { data: estimators }] = await Promise.all([
    fetchAllRows((from, to) =>
      sb
        .from("appointments")
        .select("id,title,starts_at,ends_at,all_day,appt_type,status,location,lead_id,estimator_id")
        .order("starts_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      { strict: true },
    ),
    fetchAllRows((from, to) =>
      sb
        .from("leads")
        .select("id,name,phone,email,from_postcode,from_address,to_postcode,to_address,property_size,notes,entry_channel,gclid,gbraid,wbraid,fbclid,utm_source,utm_medium,utm_campaign")
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
      { strict: true },
    ),
    sb.from("profiles").select("id,full_name").eq("active", true).order("full_name", { ascending: true }),
  ]);

  const { baseLocation } = await getBusinessSettings(sb);

  // Per-lead survey estimator (a removal inherits it read-only).
  const surveyEst = new Map<string, string>();
  for (const a of appts) {
    if (a.appt_type === "survey" && a.status !== "cancelled" && a.lead_id && a.estimator_id && !surveyEst.has(a.lead_id))
      surveyEst.set(a.lead_id, a.estimator_id);
  }
  const leadOptions = leads.map(({ notes, ...l }) => ({
    ...l,
    lead_notes: notes,
    source: classifySource(l as unknown as LeadLite),
    surveyEstimatorId: surveyEst.get(l.id) ?? null,
  }));

  // Booked from a confirmed lead ("Book removal") — prefill the dialog with its address.
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
      <PageHeader eyebrow="Schedule" title="Removals" />
      <SchedulerView
        view="removal"
        events={appts as SchedulerEvent[]}
        leads={leadOptions}
        estimators={(estimators ?? []) as { id: string; full_name: string }[]}
        defaultEstimatorId={user?.id ?? null}
        presetLeadId={leadId ?? null}
        presetLocation={presetLocation}
        baseLocation={baseLocation}
      />
    </main>
  );
}
