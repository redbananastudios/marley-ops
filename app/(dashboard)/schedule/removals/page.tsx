import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { classifySource, type LeadLite } from "@/lib/dashboard/compute";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { listActiveBrandsOrEmpty } from "@/lib/brand";
import { applyBrandFilter, parseBrandParam } from "@/lib/brand-filter";
import { PageHeader } from "@/components/page-header";
import { BrandFilter } from "@/components/brand/brand-filter";
import {
  SchedulerView,
  type SchedulerEvent,
} from "@/components/schedule/scheduler-view";

export const dynamic = "force-dynamic";

export default async function RemovalsSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string; brand?: string }>;
}) {
  const sp = await searchParams;
  const { leadId } = sp;
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();

  // Brand layer (multi-brand PRD §4): the ?brand= filter narrows the
  // appointments read in the DB, so it must resolve before the fetch. With a
  // single active brand parseBrandParam always yields 'all' and no brand UI
  // renders — the single-brand invariant (PRD §1).
  const activeBrands = await listActiveBrandsOrEmpty(sb);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(sp, activeBrands);

  // Fetch removals + surveys both: surveys can be overlaid via the "Show surveys"
  // toggle so a survey-vs-move clash is visible without a separate Overlap page.
  const [appts, leads, { data: estimators }] = await Promise.all([
    fetchAllRows((from, to) =>
      applyBrandFilter(
        sb
          .from("appointments")
          .select("id,title,starts_at,ends_at,all_day,appt_type,status,location,lead_id,estimator_id,notes,brand"),
        brandFilter,
      )
        .order("starts_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      { strict: true },
    ),
    fetchAllRows((from, to) =>
      sb
        .from("leads")
        .select("id,client_id,name,phone,email,from_postcode,from_address,to_postcode,to_address,property_size,notes,date_confirmed_at,entry_channel,gclid,gbraid,wbraid,fbclid,utm_source,utm_medium,utm_campaign")
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
      { strict: true },
    ),
    // Estimator picker: office roles only (see the surveys page for why).
    sb
      .from("profiles")
      .select("id,full_name")
      .eq("active", true)
      .in("role", ["estimator", "admin"])
      .order("full_name", { ascending: true }),
  ]);

  const { baseLocation } = await getBusinessSettings(sb);

  // Per-lead survey estimator (a removal inherits it read-only).
  const surveyEst = new Map<string, string>();
  for (const a of appts) {
    if (a.appt_type === "survey" && a.status !== "cancelled" && a.lead_id && a.estimator_id && !surveyEst.has(a.lead_id))
      surveyEst.set(a.lead_id, a.estimator_id);
  }
  // lead_id -> date_confirmed_at, to stamp dateConfirmed per event below. A
  // removal with no lead (or a lead this sweep somehow missed) renders solid —
  // hollow is a decoration, so absence fails soft to today's rendering.
  const dateConfirmedByLead = new Map(leads.map((l) => [l.id, l.date_confirmed_at]));
  const events = appts.map((a) => ({
    ...a,
    dateConfirmed: a.lead_id
      ? !dateConfirmedByLead.has(a.lead_id) || dateConfirmedByLead.get(a.lead_id) != null
      : true,
  })) as SchedulerEvent[];

  const leadOptions = leads.map(({ notes, date_confirmed_at: _dc, ...l }) => ({
    ...l,
    lead_notes: notes,
    source: classifySource(l as unknown as LeadLite),
    surveyEstimatorId: surveyEst.get(l.id) ?? null,
  }));

  // Bare clients (no enquiry yet — usually phone callers added via Clients) are
  // bookable too: picking one opens the enquiry server-side at booking time.
  // Same pattern as the surveys diary — gate 11's brand picker only ever renders
  // off one of these options.
  const clientIdsWithLeads = new Set(leads.map((l) => (l as { client_id?: string | null }).client_id).filter(Boolean));
  // Paged like every other clients picker (/storage): a plain select truncates
  // silently at PostgREST's 1000-row cap, and a client the picker doesn't
  // offer reads as "never added" — so the office creates a duplicate.
  const bareClients = await fetchAllRows((f, t) =>
    sb
      .from("clients")
      .select("id, display_name, email, phone_raw, phone_e164, postcode_home, address_line1, town")
      .is("merged_into_id", null)
      .eq("is_active", true)
      .order("id")
      .range(f, t),
  );
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

  // Booked from a confirmed lead ("Book removal") — prefill the dialog with its address.
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
      <PageHeader eyebrow="Schedule" title="Removals" />
      <SchedulerView
        view="removal"
        events={events}
        leads={[...leadOptions, ...clientOptions]}
        estimators={(estimators ?? []) as { id: string; full_name: string }[]}
        defaultEstimatorId={user?.id ?? null}
        presetLeadId={leadId ?? null}
        presetLocation={presetLocation}
        baseLocation={baseLocation}
        brands={activeBrands.map((b) => ({
          slug: b.slug,
          name: b.name,
          shortName: b.shortName,
          initial: b.initial,
          colourPrimary: b.colourPrimary,
          colourAccent: b.colourAccent,
        }))}
        multiBrand={multi}
        brandFilterSlot={
          // Joins the "Show surveys" toggle row inside the scheduler toolbar
          // (multi-brand PRD §4) — that row lives client-side, hence the slot.
          multi ? (
            <BrandFilter
              brands={activeBrands.map((b) => ({ slug: b.slug, name: b.name, shortName: b.shortName }))}
            />
          ) : null
        }
      />
    </main>
  );
}
