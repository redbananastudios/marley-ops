import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  SchedulerView,
  type SchedulerEvent,
} from "@/components/schedule/scheduler-view";

export const dynamic = "force-dynamic";

export default async function SurveysSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const { leadId } = await searchParams;
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
    sb.from("leads").select("id,name").order("created_at", { ascending: false }),
    sb.from("profiles").select("id,full_name").eq("active", true).order("full_name", { ascending: true }),
  ]);

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
        leads={leads ?? []}
        estimators={(estimators ?? []) as { id: string; full_name: string }[]}
        defaultEstimatorId={user?.id ?? null}
        presetLeadId={leadId ?? null}
        presetLocation={presetLocation}
      />
    </div>
  );
}
