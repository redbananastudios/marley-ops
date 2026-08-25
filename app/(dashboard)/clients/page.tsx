import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ClientsView, type ClientRow } from "@/components/clients/clients-view";
import { AddClientDialog } from "@/components/clients/add-client-dialog";
import { classifySource, type SourceKey } from "@/lib/dashboard/compute";
import { getBusinessSettings } from "@/lib/settings";
import { ukPhone } from "@/lib/phone";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { listActiveBrands } from "@/lib/brand";
import { applyBrandFilter, parseBrandParam } from "@/lib/brand-filter";

export const dynamic = "force-dynamic";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const supabase = await createClient();
  const { baseLocation } = await getBusinessSettings(supabase);

  // Brand layer (multi-brand PRD §4 Clients): with a single active brand no
  // brand UI renders and the page is unchanged (the single-brand invariant,
  // PRD §1). Clients carry NO brand column (the shared-spine rule, PRD §3.2) —
  // "which brands has this client dealt with" is DERIVED from their leads,
  // never stored.
  const activeBrands = await listActiveBrands(supabase);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(await searchParams, activeBrands);

  // Unbounded tables page through fetchAllRows (PostgREST truncates at 1000 rows).
  const [clients, leads] = await Promise.all([
    fetchAllRows((f, t) =>
      supabase
        .from("clients")
        .select(
          "id, display_name, email, phone_e164, phone_raw, postcode_home, is_company, address_line1, town, county, created_at",
        )
        .is("merged_into_id", null)
        .eq("is_active", true)
        .order("id")
        .range(f, t),
    ),
    fetchAllRows((f, t) =>
      supabase
        .from("leads")
        .select(
          "client_id, submitted_at, created_at, entry_channel, phone, email, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium",
        )
        .order("id")
        .range(f, t),
    ),
  ]);

  // Supplementary brand read (multi-brand only) — id→brand per client, derived
  // from leads. The main leads read above stays untouched (its aggregation —
  // counts, last enquiry, contact fallback — is whole-client fact, never
  // brand-narrowed), and it is fail-SOFT by design; this read is fail-LOUD and
  // paged (the bookings precedent): PostgREST caps unpaged reads at 1000 rows,
  // and under a named ?brand= filter a silently truncated read would DROP
  // clients from the list rather than degrade an enrichment. The ?brand=
  // narrowing is applied IN the DB via applyBrandFilter, so when the filter
  // names one brand the map's keys ARE the clients to keep ("at least one lead
  // in the selected brand"), and on All it carries each client's full brand set
  // for the chips.
  const brandsByClient = new Map<string, string[]>();
  if (multi) {
    const leadBrands = await fetchAllRows(
      (f, t) =>
        applyBrandFilter(supabase.from("leads").select("id, client_id, brand"), brandFilter)
          .not("client_id", "is", null)
          .order("id")
          .range(f, t),
      // Strict only when a named filter makes membership ride this read; on
      // All it feeds chips only, so a transient failure degrades the chips
      // rather than 500ing the whole register.
      { strict: brandFilter !== "all" },
    );
    for (const l of leadBrands) {
      if (!l.client_id || !l.brand) continue;
      const cur = brandsByClient.get(l.client_id);
      if (!cur) brandsByClient.set(l.client_id, [l.brand]);
      else if (!cur.includes(l.brand)) cur.push(l.brand);
    }
  }

  // per-client: lead count, last enquiry, first-touch origin (earliest lead's source),
  // and latest lead contact — the fallback when the client record carries none (the
  // one-live-client-per-phone/email dedupe means contact can live only on the lead).
  type Agg = {
    count: number;
    last: number;
    firstTs: number;
    origin: SourceKey;
    phone: string | null;
    phoneTs: number;
    email: string | null;
    emailTs: number;
  };
  const agg = new Map<string, Agg>();
  for (const l of leads) {
    if (!l.client_id) continue;
    const ts = new Date(l.submitted_at || l.created_at || 0).getTime();
    const cur = agg.get(l.client_id);
    const source = classifySource(l);
    if (!cur) {
      agg.set(l.client_id, {
        count: 1,
        last: ts,
        firstTs: ts,
        origin: source,
        phone: l.phone ?? null,
        phoneTs: l.phone ? ts : 0,
        email: l.email ?? null,
        emailTs: l.email ? ts : 0,
      });
    } else {
      cur.count += 1;
      if (ts > cur.last) cur.last = ts;
      if (ts < cur.firstTs) {
        cur.firstTs = ts;
        cur.origin = source; // first-touch acquisition channel
      }
      if (l.phone && ts >= cur.phoneTs) {
        cur.phone = l.phone;
        cur.phoneTs = ts;
      }
      if (l.email && ts >= cur.emailTs) {
        cur.email = l.email;
        cur.emailTs = ts;
      }
    }
  }

  const rows: ClientRow[] = clients
    .map((c) => {
      const a = agg.get(c.id);
      // One-line address summary for the card (line1 · town · postcode).
      const address =
        [c.address_line1, c.town, c.postcode_home].filter(Boolean).join(", ").trim() || null;
      return {
        id: c.id,
        display_name: c.display_name,
        isCompany: !!c.is_company,
        email: c.email ?? a?.email ?? null,
        phone: ukPhone(c.phone_raw ?? c.phone_e164) ?? ukPhone(a?.phone ?? null),
        postcode: c.postcode_home,
        address,
        leadCount: a?.count ?? 0,
        lastLeadAt: a?.last ? new Date(a.last).toISOString() : c.created_at,
        // No leads → manually-added client; show Manual origin.
        origin: a?.origin ?? "manual",
        // Brands this client has LEADS under (derived, never stored) — empty in
        // single-brand mode, so nothing brand-shaped reaches the view.
        brands: brandsByClient.get(c.id) ?? [],
      };
    })
    // A named ?brand= shows clients having AT LEAST ONE lead in that brand
    // (multi-brand PRD §4 Clients); membership was narrowed in the DB above.
    .filter((c) => brandFilter === "all" || brandsByClient.has(c.id))
    .sort((x, y) => new Date(y.lastLeadAt ?? 0).getTime() - new Date(x.lastLeadAt ?? 0).getTime());

  // Minimal serialisable brand shape for the client component — satisfies both
  // BrandChipData and BrandFilterOption; keeps brand config (emails, phone
  // numbers, template ids) out of the client payload.
  const brandOptions = multi
    ? activeBrands.map((b) => ({
        slug: b.slug,
        name: b.name,
        shortName: b.shortName,
        initial: b.initial,
        colourPrimary: b.colourPrimary,
      }))
    : [];

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Customers" title="Clients">
        {/* GATE 11: the dialog's post-save "book survey" step opens an enquiry,
            so in multi-brand mode it needs the brand picker's options. The same
            slim rows the view uses (empty in single-brand mode — the picker
            never renders and the dialog stays byte-identical to today). */}
        <AddClientDialog brands={brandOptions} />
      </PageHeader>
      <ClientsView
        clients={rows}
        baseLocation={baseLocation}
        brands={brandOptions}
        showBrandChips={multi && brandFilter === "all"}
      />
    </main>
  );
}
