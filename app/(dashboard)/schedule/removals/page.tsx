import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  SchedulerView,
  type SchedulerEvent,
} from "@/components/schedule/scheduler-view";

export const dynamic = "force-dynamic";

export default async function RemovalsSchedulePage() {
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

  // Fetch removals + surveys both: surveys can be overlaid via the "Show surveys"
  // toggle so a survey-vs-move clash is visible without a separate Overlap page.
  const [{ data: appts }, { data: leads }, { data: estimators }] = await Promise.all([
    sb
      .from("appointments")
      .select(
        "id,title,starts_at,ends_at,all_day,appt_type,status,location,lead_id,estimator_id",
      )
      .order("starts_at", { ascending: true }),
    sb
      .from("leads")
      .select("id,name,phone,email,from_postcode,from_address")
      .order("created_at", { ascending: false }),
    sb.from("profiles").select("id,full_name").eq("active", true).order("full_name", { ascending: true }),
  ]);

  // Per-lead survey estimator (a removal inherits it read-only).
  const surveyEst = new Map<string, string>();
  for (const a of appts ?? []) {
    if (a.appt_type === "survey" && a.status !== "cancelled" && a.lead_id && a.estimator_id && !surveyEst.has(a.lead_id))
      surveyEst.set(a.lead_id, a.estimator_id);
  }
  const leadOptions = (leads ?? []).map((l) => ({ ...l, surveyEstimatorId: surveyEst.get(l.id) ?? null }));

  return (
    <div>
      <PageHeader eyebrow="Schedule" title="Removals" />
      <SchedulerView
        view="removal"
        events={(appts ?? []) as SchedulerEvent[]}
        leads={leadOptions}
        estimators={(estimators ?? []) as { id: string; full_name: string }[]}
        defaultEstimatorId={user?.id ?? null}
      />
    </div>
  );
}
