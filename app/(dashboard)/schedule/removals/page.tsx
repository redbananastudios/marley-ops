import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  SchedulerView,
  type SchedulerEvent,
} from "@/components/schedule/scheduler-view";

export const dynamic = "force-dynamic";

export default async function RemovalsSchedulePage() {
  const sb = await createClient();

  // Fetch removals + surveys both: surveys can be overlaid via the "Show surveys"
  // toggle so a survey-vs-move clash is visible without a separate Overlap page.
  const [{ data: appts }, { data: leads }] = await Promise.all([
    sb
      .from("appointments")
      .select(
        "id,title,starts_at,ends_at,all_day,appt_type,status,location,lead_id",
      )
      .order("starts_at", { ascending: true }),
    sb.from("leads").select("id,name").order("created_at", { ascending: false }),
  ]);

  return (
    <div>
      <PageHeader eyebrow="Schedule" title="Removals" />
      <SchedulerView
        view="removal"
        events={(appts ?? []) as SchedulerEvent[]}
        leads={leads ?? []}
      />
    </div>
  );
}
