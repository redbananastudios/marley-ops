import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { crewRequired } from "@/lib/job-board";
import { packRequirement } from "@/lib/schedule/pack-days";
import { getBusinessSettings } from "@/lib/settings";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import type { QuoteBreakdown } from "@/lib/quote/pricing";
import {
  ScheduleAllocationView,
  type AvailAppt,
  type SoftDemandItem,
} from "@/components/schedule/schedule-allocation-view";
import type {
  BoardAppt,
  BoardAssignment,
  BoardStaff,
  BoardStaffAvailability,
  BoardUnavailability,
  BoardVehicle,
} from "@/components/job-board/job-board-view";

export const dynamic = "force-dynamic";

/**
 * Schedule & Allocation — one page, two views of the same day (design doc
 * docs/schedule-allocation-design.md). ADDITIVE: the existing /schedule/removals
 * diary and /schedule/board Job Board are untouched. Availability answers "can we
 * sell this day?" (capacity from the confirmed removals' required vans/crew vs the
 * live fleet); Day Allocation reuses the Job Board for dispatch, surveys hidden.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [appts, leads, quotes, { data: staff }, { data: vehicles }, assignments, unavailability, staffAvailability, bookingDetails, { data: estimators }] =
    await Promise.all([
      fetchAllRows((f, t) =>
        supabase
          .from("appointments")
          .select("id, title, starts_at, ends_at, all_day, appt_type, status, location, lead_id, estimator_id")
          .neq("status", "cancelled")
          .order("id")
          .range(f, t),
      ),
      fetchAllRows((f, t) =>
        supabase
          .from("leads")
          .select(
            "id, name, status, phone, email, from_postcode, from_address, to_postcode, to_address, property_size, notes, entry_channel, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium, utm_campaign",
          )
          .order("id")
          .range(f, t),
      ),
      fetchAllRows((f, t) =>
        supabase
          .from("quotes")
          .select("id, lead_id, status, breakdown, deposit_paid_at, commitment_paid_at, moving_date")
          .eq("status", "accepted")
          .order("id")
          .range(f, t),
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
      fetchAllRows((f, t) =>
        supabase
          .from("booking_details")
          .select("lead_id, approx_window, approx_month, provisional_date, property_type")
          .order("lead_id")
          .range(f, t),
      ),
      supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
    ]);

  const { baseLocation } = await getBusinessSettings(supabase);

  const leadById = new Map(leads.map((l) => [l.id, l]));
  const bdByLead = new Map(bookingDetails.map((b) => [b.lead_id, b]));

  // Lead options for the create/edit appointment dialog (mirrors /schedule/removals).
  const surveyEst = new Map<string, string>();
  for (const a of appts) {
    if (a.appt_type === "survey" && a.lead_id && a.estimator_id && !surveyEst.has(a.lead_id))
      surveyEst.set(a.lead_id, a.estimator_id);
  }
  const leadOptions = leads.map(({ notes, status: _status, ...l }) => ({
    ...l,
    lead_notes: notes,
    source: classifySource(l as unknown as LeadLite),
    surveyEstimatorId: surveyEst.get(l.id) ?? null,
  }));

  // required vans/crew derived from the lead's first accepted quote (reuse the Job Board's logic).
  const reqByLead = new Map<string, { vans: number; men: number }>();
  const payByLead = new Map<string, { deposit: boolean; commitment: boolean }>();
  for (const q of quotes) {
    if (!q.lead_id) continue;
    if (!reqByLead.has(q.lead_id)) {
      const req = crewRequired((q.breakdown ?? null) as Partial<QuoteBreakdown> | null);
      if (req) reqByLead.set(q.lead_id, req);
    }
    if (!payByLead.has(q.lead_id)) {
      payByLead.set(q.lead_id, { deposit: !!q.deposit_paid_at, commitment: !!q.commitment_paid_at });
    }
  }

  // Contract-signature state per lead (amber "signature on arrival" flag on the board).
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
    sigNeededByLead.set(q.lead_id, !signedQuoteIds.has(q.id));
  }

  // Crew assigned per appointment — a pack day's demand follows its allocation
  // (packRequirement: at least one person, van optional).
  const crewByAppt = new Map<string, number>();
  for (const a of assignments) {
    if (a.staff_id) crewByAppt.set(a.appointment_id, (crewByAppt.get(a.appointment_id) ?? 0) + 1);
  }

  const boardCards: BoardAppt[] = appts.map((a) => {
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
      required:
        a.appt_type === "removal" && a.lead_id
          ? (reqByLead.get(a.lead_id) ?? null)
          : a.appt_type === "pack"
            ? packRequirement(crewByAppt.get(a.id) ?? 0)
            : null,
      sigNeeded: a.appt_type === "removal" && a.lead_id ? (sigNeededByLead.get(a.lead_id) ?? false) : false,
    };
  });

  // Availability month = the factual diary: confirmed removals + their packing
  // days (both consume capacity; starts_at is non-null in the DB, but the shared
  // BoardAppt type is nullable — narrow it here).
  const removals = boardCards.filter(
    (c): c is BoardAppt & { starts_at: string } =>
      (c.appt_type === "removal" || c.appt_type === "pack") && c.starts_at != null,
  );
  // Soft-demand exclusion counts REMOVALS only — an orphaned pack must never
  // hide a deposit-paid lead from the "thinking about it" sell panel.
  const removalLeadIds = new Set(
    removals.filter((r) => r.appt_type === "removal").map((r) => r.lead_id).filter(Boolean) as string[],
  );

  const apptById = new Map(appts.map((a) => [a.id, a]));
  const availAppts: AvailAppt[] = removals.map((r) => {
    const raw = apptById.get(r.id);
    return {
      id: r.id,
      appt_type: r.appt_type,
      lead_id: r.lead_id,
      lead_name: r.lead_name,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      all_day: r.all_day,
      from_postcode: r.from_postcode,
      to_postcode: r.to_postcode,
      requiredVans: r.required?.vans ?? 0,
      requiredCrew: r.required?.men ?? 0,
      property_type: r.lead_id ? (bdByLead.get(r.lead_id)?.property_type ?? null) : null,
      approx_window: r.lead_id ? (bdByLead.get(r.lead_id)?.approx_window ?? null) : null,
      approx_month: r.lead_id ? (bdByLead.get(r.lead_id)?.approx_month ?? null) : null,
      provisional_date: r.lead_id ? (bdByLead.get(r.lead_id)?.provisional_date ?? null) : null,
      deposit: r.lead_id ? (payByLead.get(r.lead_id)?.deposit ?? false) : false,
      commitment: r.lead_id ? (payByLead.get(r.lead_id)?.commitment ?? false) : false,
      // For the view/edit/reschedule dialogs (mirrors the removals diary payload).
      title: raw?.title ?? null,
      status: raw?.status ?? null,
      location: raw?.location ?? null,
      estimator_id: raw?.estimator_id ?? null,
    };
  });

  // Soft demand ("thinking about it") = deposit paid but no removal on the diary yet.
  const softDemand: SoftDemandItem[] = quotes
    .filter((q) => q.lead_id && q.deposit_paid_at && !removalLeadIds.has(q.lead_id))
    .map((q) => {
      const lead = leadById.get(q.lead_id!);
      const bd = bdByLead.get(q.lead_id!);
      const req = reqByLead.get(q.lead_id!);
      return {
        lead_id: q.lead_id!,
        name: lead?.name ?? "Customer",
        approx_window: bd?.approx_window ?? null,
        approx_month: bd?.approx_month ?? null,
        provisional_date: bd?.provisional_date ?? null,
        property_type: bd?.property_type ?? null,
        requiredVans: req?.vans ?? null,
        requiredCrew: req?.men ?? null,
        commitment: payByLead.get(q.lead_id!)?.commitment ?? false,
      };
    });

  const ukToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const mondayOf = (isoDate: string): string => {
    const t = new Date(`${isoDate}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
    return t.toISOString().slice(0, 10);
  };
  const selectedDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ukToday;
  const fleet = { vans: (vehicles ?? []).length, crew: (staff ?? []).length };

  return (
    <main className="flex flex-1 flex-col p-6 md:p-8">
      <PageHeader eyebrow="Schedule" title="Schedule & Allocation" />
      <ScheduleAllocationView
        fleet={fleet}
        availAppts={availAppts}
        softDemand={softDemand}
        selectedDate={selectedDate}
        today={ukToday}
        leads={leadOptions}
        estimators={(estimators ?? []) as { id: string; full_name: string }[]}
        defaultEstimatorId={user?.id ?? null}
        baseLocation={baseLocation}
        events={appts}
        board={{
          appts: boardCards,
          staff: (staff ?? []) as BoardStaff[],
          vehicles: (vehicles ?? []) as BoardVehicle[],
          assignments: assignments as BoardAssignment[],
          unavailability: unavailability as BoardUnavailability[],
          staffAvailability: staffAvailability as BoardStaffAvailability[],
          thisWeekStart: mondayOf(ukToday),
          today: ukToday,
        }}
      />
    </main>
  );
}
