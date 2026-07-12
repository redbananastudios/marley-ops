import { createClient } from "@/lib/supabase/server";
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

  const [{ data: appts }, { data: leads }, { data: estimators }] = await Promise.all([
    sb
      .from("appointments")
      .select(
        "id,title,starts_at,ends_at,all_day,appt_type,status,location,lead_id,estimator_id",
      )
      .eq("appt_type", "survey")
      .order("starts_at", { ascending: true }),
    sb
      .from("leads")
      .select(
        "id,client_id,name,phone,email,from_postcode,from_address,to_postcode,to_address,property_size,notes,entry_channel,gclid,gbraid,wbraid,fbclid,utm_source,utm_medium,utm_campaign",
      )
      .order("created_at", { ascending: false }),
    sb.from("profiles").select("id,full_name").eq("active", true).order("full_name", { ascending: true }),
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
    <div>
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
    </div>
  );
}
