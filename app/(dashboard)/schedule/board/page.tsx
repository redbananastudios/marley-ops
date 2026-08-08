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
  type BoardStaffAvailability,
  type BoardUnavailability,
  type BoardVehicle,
} from "@/components/job-board/job-board-view";

export const dynamic = "force-dynamic";

export default async function JobBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  const supabase = await createClient();

  const [appts, leads, quotes, { data: staff }, { data: vehicles }, assignments, unavailability, staffAvailability] = await Promise.all([
    fetchAllRows((f, t) =>
      supabase
        .from("appointments")
        .select("id, title, starts_at, ends_at, all_day, appt_type, status, location, lead_id, notes")
        .neq("status", "cancelled")
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("leads").select("id, name, status, from_postcode, to_postcode").order("id").range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("quotes").select("id, lead_id, status, source, breakdown").eq("status", "accepted").order("id").range(f, t),
    ),
    supabase.from("staff").select("id, full_name, staff_role, working_days, is_driver").eq("is_active", true).order("full_name"),
    supabase
      .from("vehicles")
      .select("id, name, vehicle_type, registration, tax_due, mot_due, insurance_renewal, service_due, end_of_term")
      .eq("is_active", true)
      .order("name"),
    fetchAllRows((f, t) =>
      supabase.from("appointment_assignments").select("id, appointment_id, staff_id, vehicle_id").order("id").range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("vehicle_unavailability").select("vehicle_id, start_date, end_date, reason").order("id").range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase.from("staff_availability").select("staff_id, date, status, note").order("id").range(f, t),
    ),
  ]);

  const leadById = new Map(leads.map((l) => [l.id, l]));
  const reqByLead = new Map<string, { vans: number; men: number }>();
  for (const q of quotes) {
    if (!q.lead_id || reqByLead.has(q.lead_id)) continue;
    const req = crewRequired((q.breakdown ?? null) as Partial<QuoteBreakdown> | null);
    if (req) reqByLead.set(q.lead_id, req);
  }

  // Contract-signature state per lead: accepted quote with no signature row →
  // the crew must collect on arrival (amber flag on the removal card).
  const quoteIds = quotes.map((q) => q.id).filter(Boolean) as string[];
  const signedQuoteIds = new Set<string>();
  if (quoteIds.length) {
    const sigs = await fetchAllRows((f, t) =>
      supabase.from("signatures").select("quote_id").eq("kind", "contract").order("id").range(f, t),
    );
    for (const s of sigs) if (s.quote_id) signedQuoteIds.add(s.quote_id);
  }
  const sigNeededByLead = new Map<string, boolean>();
  for (const q of quotes) {
    if (!q.lead_id || sigNeededByLead.has(q.lead_id)) continue;
    // Legacy iMVE jobs signed the old system's paperwork — never nag the crew
    // to collect a Marley contract that was never part of their deal.
    sigNeededByLead.set(q.lead_id, q.source === "imve" ? false : !signedQuoteIds.has(q.id));
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
      sigNeeded: a.appt_type === "removal" && a.lead_id ? (sigNeededByLead.get(a.lead_id) ?? false) : false,
    };
  });

  // Monday of the given date's UK week — the board's Mon–Sun window.
  const mondayOf = (isoDate: string): string => {
    const t = new Date(`${isoDate}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return t.toISOString().slice(0, 10);
  };
  const ukToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const thisWeekStart = mondayOf(ukToday);
  // ?week=<YYYY-MM-DD> deep-links the board to that date's week (Bookings'
  // "Assign crew" bridge lands on the move's week, not today's). Anything
  // malformed falls back to the current week. Years are bounded because
  // extreme dates survive Date.parse but break toISOString's yyyy-mm-dd shape
  // (expanded-year forms like "-000001-…"), corrupting the day columns.
  const weekParam =
    typeof week === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(week) &&
    week >= "2000-01-01" &&
    week <= "2100-12-31" &&
    !Number.isNaN(Date.parse(`${week}T00:00:00Z`))
      ? mondayOf(week)
      : null;

  return (
    <main className="flex flex-1 flex-col p-6 md:p-8">
      <PageHeader eyebrow="Schedule" title="Job Board" />
      <JobBoardView
        appts={cards}
        staff={(staff ?? []) as BoardStaff[]}
        vehicles={(vehicles ?? []) as BoardVehicle[]}
        assignments={assignments as BoardAssignment[]}
        unavailability={unavailability as BoardUnavailability[]}
        staffAvailability={staffAvailability as BoardStaffAvailability[]}
        thisWeekStart={thisWeekStart}
        initialWeekStart={weekParam ?? thisWeekStart}
        today={ukToday}
      />
    </main>
  );
}
