import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  SchedulerView,
  type SchedulerEvent,
} from "@/components/schedule/scheduler-view";

export const dynamic = "force-dynamic";

export default async function SurveysSchedulePage() {
  const sb = await createClient();

  const [{ data: appts }, { data: leads }] = await Promise.all([
    sb
      .from("appointments")
      .select(
        "id,title,starts_at,ends_at,all_day,appt_type,status,location,lead_id",
      )
      .eq("appt_type", "survey")
      .order("starts_at", { ascending: true }),
    sb.from("leads").select("id,name").order("created_at", { ascending: false }),
  ]);

  return (
    <div>
      <PageHeader eyebrow="Schedule" title="Surveys" />
      <SchedulerView
        view="survey"
        events={(appts ?? []) as SchedulerEvent[]}
        leads={leads ?? []}
      />
    </div>
  );
}
