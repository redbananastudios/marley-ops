import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { crewRequired } from "@/lib/job-board";
import type { QuoteBreakdown } from "@/lib/quote/pricing";
import {
  JobBoardView,
  type BoardAppt,
  type BoardAssignment,
  type BoardStaff,
  type BoardVehicle,
} from "@/components/job-board/job-board-view";

export const dynamic = "force-dynamic";

export default async function JobBoardPage() {
  const supabase = await createClient();

  const [appts, leads, quotes, { data: staff }, { data: vehicles }, assignments] = await Promise.all([
    fetchAllRows((f, t) =>
      supabase
        .from("appointments")
        .select("id, title, starts_at, ends_at, all_day, appt_type, status, location, lead_id")
        .neq("status", "cancelled")
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("leads").select("id, name, status, from_postcode, to_postcode").order("id").range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("quotes").select("lead_id, status, breakdown").eq("status", "accepted").order("id").range(f, t),
    ),
    supabase.from("staff").select("id, full_name, staff_role").eq("is_active", true).order("full_name"),
    supabase
      .from("vehicles")
      .select("id, name, vehicle_type, registration, tax_due, mot_due, insurance_renewal")
      .eq("is_active", true)
      .order("name"),
    fetchAllRows((f, t) =>
      supabase.from("appointment_assignments").select("id, appointment_id, staff_id, vehicle_id").order("id").range(f, t),
    ),
  ]);

  const leadById = new Map(leads.map((l) => [l.id, l]));
  const reqByLead = new Map<string, { vans: number; men: number }>();
  for (const q of quotes) {
    if (!q.lead_id || reqByLead.has(q.lead_id)) continue;
    const req = crewRequired((q.breakdown ?? null) as Partial<QuoteBreakdown> | null);
    if (req) reqByLead.set(q.lead_id, req);
  }

  const cards: BoardAppt[] = appts.map((a) => {
    const lead = a.lead_id ? leadById.get(a.lead_id) : null;
    return {
      id: a.id,
      title: a.title,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      all_day: a.all_day,
      appt_type: a.appt_type,
      lead_id: a.lead_id,
      lead_name: lead?.name ?? null,
      lead_status: lead?.status ?? null,
      from_postcode: lead?.from_postcode ?? null,
      to_postcode: lead?.to_postcode ?? null,
      required: a.appt_type === "removal" && a.lead_id ? (reqByLead.get(a.lead_id) ?? null) : null,
    };
  });

  // Monday of the current UK week — the board's Mon–Sun window.
  const ukToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const t = new Date(`${ukToday}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  const thisWeekStart = t.toISOString().slice(0, 10);

  return (
    <main className="flex flex-1 flex-col p-6 md:p-8">
      <PageHeader eyebrow="Schedule" title="Job Board" />
      <JobBoardView
        appts={cards}
        staff={(staff ?? []) as BoardStaff[]}
        vehicles={(vehicles ?? []) as BoardVehicle[]}
        assignments={assignments as BoardAssignment[]}
        thisWeekStart={thisWeekStart}
        today={ukToday}
      />
    </main>
  );
}
