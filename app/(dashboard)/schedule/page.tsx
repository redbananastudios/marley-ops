import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { crewRequired } from "@/lib/job-board";
import { packRequirement } from "@/lib/schedule/pack-days";
import { MIN_BOOKED_REQUIREMENT } from "@/lib/schedule/capacity";
import { jobValueOf, pickCurrentQuotes } from "@/lib/schedule/week-value";
import { getBusinessSettings } from "@/lib/settings";
import { listActiveBrands } from "@/lib/brand";
import { parseBrandParam } from "@/lib/brand-filter";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import type { QuoteBreakdown } from "@/lib/quote/pricing";
import { importedBooking } from "@/lib/legacy";
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
 * diary is untouched; the board itself is embedded here now that the
 * standalone /schedule/board page is gone. Availability answers "can we
 * sell this day?" (capacity from the confirmed removals' required vans/crew vs the
 * live fleet); Day Allocation reuses the Job Board for dispatch, surveys hidden.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; brand?: string }>;
}) {
  const sp = await searchParams;
  const { date } = sp;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Brand layer (multi-brand PRD §4 /schedule): with a single active brand no
  // brand UI renders and the page is unchanged (the single-brand invariant,
  // PRD §1). The ?brand= filter narrows the DAY ALLOCATION job cards only —
  // the Availability month grid is NEVER brand-filtered, because crew and vans
  // are one shared pool and per-brand capacity would show headroom another
  // brand's job has already taken.
  const activeBrands = await listActiveBrands(supabase);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(sp, activeBrands);
  // Job values are admin-only, matching /payments Due + Upcoming — /schedule is
  // an estimator surface too, and it has never shown money before.
  const { data: viewerProfile } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).single()
    : { data: null };
  const isAdmin = viewerProfile?.role === "admin";

  const [appts, leads, quotes, { data: staff }, { data: vehicles }, assignments, unavailability, staffAvailability, bookingDetails, { data: estimators }] =
    await Promise.all([
      fetchAllRows(
        (f, t) =>
          supabase
            .from("appointments")
            // `brand` is denormalised from the lead (PRD §3.2) — the board
            // chips and the allocation narrowing read it without a join.
            .select("id, title, brand, starts_at, ends_at, all_day, appt_type, status, location, lead_id, estimator_id, notes")
            .neq("status", "cancelled")
            .order("id")
            .range(f, t),
        // This read always fetches EVERY brand (capacity/clash need the full
        // pool); a named ?brand= filter narrows the visible cards downstream
        // in JobBoardView. But with a filter active a partial window here
        // would render a wrong-narrowed board that LOOKS complete, so the
        // read fails LOUD then. Unfiltered keeps today's fail-soft.
        { strict: brandFilter !== "all" },
      ),
      fetchAllRows((f, t) =>
        supabase
          .from("leads")
          .select(
            "id, name, status, phone, email, from_postcode, from_address, to_postcode, to_address, property_size, notes, entry_channel, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium, utm_campaign, balance_paid_at",
          )
          .order("id")
          .range(f, t),
      ),
      fetchAllRows((f, t) =>
        supabase
          .from("quotes")
          .select("id, lead_id, status, source, breakdown, deposit_paid_at, deposit_amount, commitment_paid_at, commitment_invoice_amount, accepted_at, booking_cancelled_at, moving_date, agreed_price, grand_total")
          .eq("status", "accepted")
          .order("id")
          .range(f, t),
      ),
      supabase.from("staff").select("id, full_name, staff_role, working_days, is_driver").eq("is_active", true).order("full_name"),
      supabase
        .from("vehicles")
        // `brand` = livery only (multi-brand PRD §4 /resources) — feeds the
        // board's soft mismatch note; a decorating read, so it fails soft.
        .select("id, name, vehicle_type, registration, tax_due, mot_due, insurance_renewal, service_due, end_of_term, brand")
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
      // Estimator picker: office roles only (see the surveys page for why).
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("active", true)
        .in("role", ["estimator", "admin"])
        .order("full_name"),
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
  const leadOptions = leads.map(({ notes, status: _status, balance_paid_at: _balancePaid, ...l }) => ({
    ...l,
    lead_notes: notes,
    source: classifySource(l as unknown as LeadLite),
    surveyEstimatorId: surveyEst.get(l.id) ?? null,
  }));

  // Required vans/crew + money chips come from the lead's CURRENT accepted quote
  // (reuse the Job Board's logic). Rows arrive ordered by id — UUID order, i.e.
  // arbitrary — so a re-quoted lead with two accepted rows used to grade capacity
  // and render money chips off whichever won the coin toss, and cancelled
  // bookings were included. Take the most recently accepted live quote, the same
  // rule /bookings uses.
  const reqByLead = new Map<string, { vans: number; men: number }>();
  const payByLead = new Map<string, { deposit: boolean; commitment: boolean; commitmentApplies: boolean }>();
  /** What each booked job is worth, for the month calendar's week rail. */
  const valueByLead = new Map<string, { value: number | null; toCollect: number | null }>();
  const legacyLeadIds = new Set<string>();
  // Shared with /schedule/removals so the two calendars can never disagree
  // about which quote a booked job's figures come from.
  const currentQuoteByLead = pickCurrentQuotes(quotes);
  for (const [leadId, q] of currentQuoteByLead) {
    const req = crewRequired((q.breakdown ?? null) as Partial<QuoteBreakdown> | null);
    if (req) reqByLead.set(leadId, req);
    payByLead.set(leadId, {
      deposit: !!q.deposit_paid_at,
      commitment: !!q.commitment_paid_at,
      // The 25% chip is only meaningful when a commitment was actually invoiced.
      // ensureCommitmentInvoice raises nothing when the date was never confirmed
      // or when the deposit already covers 25%, leaving commitment_paid_at null
      // forever — so keying the chip off that alone printed "25% due" on
      // fully-paid jobs and sent the office chasing money never asked for.
      commitmentApplies: Number(q.commitment_invoice_amount ?? 0) > 0,
    });
    valueByLead.set(leadId, jobValueOf(q, Boolean(leadById.get(leadId)?.balance_paid_at)));
    if (q.source === "imve") legacyLeadIds.add(leadId);
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
    // Imported jobs signed the other system's paperwork — never nag the crew
    // to collect a Marley contract that was never part of their deal.
    sigNeededByLead.set(
      q.lead_id,
      importedBooking(q.source ?? null) ? false : !signedQuoteIds.has(q.id),
    );
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
      brand: a.brand,
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
      // A booked removal with no priceable quote (or a lead-less manual block) has a
      // null requirement — floor it to a real move's minimum so its day is never graded
      // as needing nothing (which would overstate sellable capacity). Packs always carry
      // a packRequirement, so this floor only ever hits genuine removals.
      requiredVans: r.required?.vans ?? (r.appt_type === "removal" ? MIN_BOOKED_REQUIREMENT.requiredVans : 0),
      requiredCrew: r.required?.men ?? (r.appt_type === "removal" ? MIN_BOOKED_REQUIREMENT.requiredCrew : 0),
      property_type: r.lead_id ? (bdByLead.get(r.lead_id)?.property_type ?? null) : null,
      approx_window: r.lead_id ? (bdByLead.get(r.lead_id)?.approx_window ?? null) : null,
      approx_month: r.lead_id ? (bdByLead.get(r.lead_id)?.approx_month ?? null) : null,
      provisional_date: r.lead_id ? (bdByLead.get(r.lead_id)?.provisional_date ?? null) : null,
      deposit: r.lead_id ? (payByLead.get(r.lead_id)?.deposit ?? false) : false,
      commitment: r.lead_id ? (payByLead.get(r.lead_id)?.commitment ?? false) : false,
      commitmentApplies: r.lead_id ? (payByLead.get(r.lead_id)?.commitmentApplies ?? false) : false,
      legacy: r.lead_id ? legacyLeadIds.has(r.lead_id) : false,
      value: r.lead_id ? (valueByLead.get(r.lead_id)?.value ?? null) : null,
      toCollect: r.lead_id ? (valueByLead.get(r.lead_id)?.toCollect ?? null) : null,
      // For the view/edit/reschedule dialogs (mirrors the removals diary payload).
      title: raw?.title ?? null,
      status: raw?.status ?? null,
      location: raw?.location ?? null,
      estimator_id: raw?.estimator_id ?? null,
      notes: raw?.notes ?? null,
    };
  });

  // Soft demand ("thinking about it") = deposit paid but no removal on the diary yet.
  // A cancelled booking keeps quote.status='accepted' + deposit_paid_at (cancelBookingAction
  // only stamps booking_cancelled_at and cancels the removal appointment), so without the
  // booking_cancelled_at guard a refunded customer re-enters "thinking about it" and staff
  // ring them to reserve against a deposit already given back.
  const softDemand: SoftDemandItem[] = quotes
    .filter((q) => q.lead_id && q.deposit_paid_at && !q.booking_cancelled_at && !removalLeadIds.has(q.lead_id))
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

  // Minimal serialisable brand shape for the client components — the segmented
  // filter, the board's chips and the booking dialog's brand picker; keeps
  // brand config (emails, phone numbers, template ids) out of the client
  // payload. Mirrors the /board (gate 3) wiring.
  const brandOptions = multi
    ? activeBrands.map((b) => ({
        slug: b.slug,
        name: b.name,
        shortName: b.shortName,
        initial: b.initial,
        colourPrimary: b.colourPrimary,
        colourAccent: b.colourAccent,
      }))
    : [];

  return (
    <main className="flex flex-1 flex-col p-6 md:p-8">
      <PageHeader eyebrow="Schedule" title="Schedule & Allocation" />
      <ScheduleAllocationView
        availAppts={availAppts}
        showWeekValue={isAdmin}
        softDemand={softDemand}
        selectedDate={selectedDate}
        today={ukToday}
        leads={leadOptions}
        estimators={(estimators ?? []) as { id: string; full_name: string }[]}
        defaultEstimatorId={user?.id ?? null}
        baseLocation={baseLocation}
        events={appts}
        brands={brandOptions}
        showBrandChips={multi && brandFilter === "all"}
        // The board gets the FULL set — narrowing to ?brand= happens on the
        // VISIBLE cards inside JobBoardView, so its capacity strips and clash
        // warnings still count the other brand's jobs (one crew/van pool).
        brandFilter={brandFilter}
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
