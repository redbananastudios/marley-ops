import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { getBusinessSettings } from "@/lib/settings";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { listActiveBrands } from "@/lib/brand";
import { applyBrandFilter, parseBrandParam } from "@/lib/brand-filter";
import { PageHeader } from "@/components/page-header";
import { BrandFilter } from "@/components/brand/brand-filter";
import {
  SchedulerView,
  type SchedulerEvent,
} from "@/components/schedule/scheduler-view";

export const dynamic = "force-dynamic";

export default async function SurveysSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string; new?: string; brand?: string }>;
}) {
  const sp = await searchParams;
  const { leadId, new: createNew } = sp;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

  // Brand layer (multi-brand PRD §4): the ?brand= filter narrows the
  // appointments read in the DB, so it must resolve before the fetch. With a
  // single active brand parseBrandParam always yields 'all' and no brand UI
  // renders — the single-brand invariant (PRD §1).
  const activeBrands = await listActiveBrands(sb);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(sp, activeBrands);

  // appts + leads are unbounded and grow for the life of the business → page
  // through fetchAllRows (a plain select truncates at PostgREST's 1000-row cap;
  // the lead picker below reads this array directly, so past 1000 rows recent
  // leads would silently vanish from it). id is a unique tiebreaker so the
  // display order (starts_at / created_at) pages without skips or duplicates.
  const [appts, leads, { data: estimators }] = await Promise.all([
    fetchAllRows(
      (f, t) =>
        applyBrandFilter(
          sb
            .from("appointments")
            .select(
              "id,title,starts_at,ends_at,all_day,appt_type,status,location,lead_id,estimator_id,notes,brand",
            )
            .eq("appt_type", "survey"),
          brandFilter,
        )
          .order("starts_at", { ascending: true })
          .order("id")
          .range(f, t),
      // A read narrowing to a named brand fails LOUD — a partial window under
      // a filter would silently drop that brand's surveys. Unfiltered keeps
      // today's fail-soft rendering.
      { strict: brandFilter !== "all" },
    ),
    fetchAllRows((f, t) =>
      sb
        .from("leads")
        .select(
          "id,client_id,name,phone,email,from_postcode,from_address,to_postcode,to_address,property_size,notes,date_confirmed_at,entry_channel,gclid,gbraid,wbraid,fbclid,utm_source,utm_medium,utm_campaign",
        )
        .order("created_at", { ascending: false })
        .order("id")
        .range(f, t),
    ),
    // Only people who can actually DO a survey. The list used to include crew:
    // assigning one meant they never saw the visit (/my-jobs is driven by crew
    // assignments, not estimator_id), could never bill it, and the customer had
    // already been emailed their name as the person coming.
    sb
      .from("profiles")
      .select("id,full_name")
      .eq("active", true)
      .in("role", ["estimator", "admin"])
      .order("full_name", { ascending: true }),
  ]);

  const { baseLocation } = await getBusinessSettings(sb);

  // Per-lead survey estimator (so a removal can inherit it read-only).
  const surveyEst = new Map<string, string>();
  for (const a of appts ?? []) {
    if (a.appt_type === "survey" && a.status !== "cancelled" && a.lead_id && a.estimator_id && !surveyEst.has(a.lead_id))
      surveyEst.set(a.lead_id, a.estimator_id);
  }
  // lead_id -> date_confirmed_at, to stamp dateConfirmed per event below.
  // Surveys have no confirmation concept and always render solid, but the
  // stamp is uniform so the shape matches the removals page.
  const dateConfirmedByLead = new Map((leads ?? []).map((l) => [l.id, l.date_confirmed_at]));
  const events = (appts ?? []).map((a) => ({
    ...a,
    dateConfirmed: a.lead_id
      ? !dateConfirmedByLead.has(a.lead_id) || dateConfirmedByLead.get(a.lead_id) != null
      : true,
  })) as SchedulerEvent[];

  const leadOptions = (leads ?? []).map(({ notes, date_confirmed_at: _dc, ...l }) => ({
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
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Schedule" title="Surveys">
        {/* Brand filter (multi-brand PRD §4) — this view has no toolbar row
            of its own, so the segmented control lives in the PageHeader. */}
        {multi ? (
          <BrandFilter
            brands={activeBrands.map((b) => ({ slug: b.slug, name: b.name, shortName: b.shortName }))}
          />
        ) : null}
      </PageHeader>
      <SchedulerView
        view="survey"
        events={events}
        leads={[...leadOptions, ...clientOptions]}
        estimators={(estimators ?? []) as { id: string; full_name: string }[]}
        defaultEstimatorId={user?.id ?? null}
        presetLeadId={leadId ?? null}
        presetLocation={presetLocation}
        openOnLoad={createNew === "1"}
        baseLocation={baseLocation}
        brands={activeBrands.map((b) => ({
          slug: b.slug,
          shortName: b.shortName,
          initial: b.initial,
          colourPrimary: b.colourPrimary,
          colourAccent: b.colourAccent,
        }))}
        multiBrand={multi}
      />
    </main>
  );
}
