import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { ukPhone } from "@/lib/phone";
import { nextInvoiceDateFor, type BillableLet } from "@/lib/storage-billing";
import { getStorageRates } from "@/lib/storage-rates";
import { listActiveBrands } from "@/lib/brand";
import { applyBrandFilter, parseBrandParam } from "@/lib/brand-filter";
import {
  StorageView,
  type HandlingEventRow,
  type LetInvoice,
  type LetRow,
  type PickerClient,
  type SiteRow,
  type UnitRow,
} from "@/components/storage/storage-view";

export const dynamic = "force-dynamic";

export default async function StoragePage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const supabase = await createClient();

  // Brand layer (multi-brand PRD §4 /storage): with a single active brand no
  // brand UI renders and the page is unchanged (the single-brand invariant,
  // PRD §1). Sites carry their own brand; lets carry the brand stamped at
  // creation (originating lead, falling back to the site — PRD §2).
  const activeBrands = await listActiveBrands(supabase);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(await searchParams, activeBrands);

  const [sitesRes, { data: units }, lets, clients] = await Promise.all([
    applyBrandFilter(supabase.from("storage_sites").select("*"), brandFilter)
      .order("is_active", { ascending: false })
      .order("name"),
    supabase.from("storage_units").select("*").order("is_active", { ascending: false }).order("code").order("name"),
    // Full let history stays small for a long time (1 site today); page it anyway.
    fetchAllRows(
      (f, t) =>
        supabase
          .from("storage_lets")
          .select(
            "id, unit_id, client_id, brand, start_date, end_date, rate, rate_period, notes, billing_paused, billing_model, min_days, min_amount",
          )
          .order("id")
          .range(f, t),
      // Every brand is always fetched — occupancy is a physical fact derived
      // from the FULL let pool, so a named ?brand= narrows the visible let
      // details downstream in StorageView, never this read. But with a filter
      // active a partial window would render a wrong-narrowed view that LOOKS
      // complete, so the read fails LOUD then. Unfiltered keeps today's
      // fail-soft.
      { strict: brandFilter !== "all" },
    ),
    fetchAllRows((f, t) =>
      supabase
        .from("clients")
        .select("id, display_name, email, phone_e164, phone_raw")
        .is("merged_into_id", null)
        .eq("is_active", true)
        .order("id")
        .range(f, t),
    ),
  ]);

  // The sites read is the named-brand narrowing read for this page, so it
  // fails LOUD under a filter — a silently empty site list would look like a
  // complete answer. On All it keeps today's fail-soft render.
  const { data: sites, error: sitesError } = sitesRes;
  if (sitesError && brandFilter !== "all") {
    throw new Error(`Could not load storage sites: ${sitesError.message}`);
  }

  // Assign-dialog pre-fill (multi-brand only): each client's most recent
  // lead's brand. startLetAction re-resolves this SERVER-SIDE at write time,
  // so this is display decoration and fails SOFT.
  const leadBrandByClient = new Map<string, string>();
  if (multi) {
    const leadRows = await fetchAllRows((f, t) =>
      supabase
        .from("leads")
        .select("client_id, brand, created_at")
        .not("client_id", "is", null)
        .order("created_at", { ascending: true })
        .order("id")
        .range(f, t),
    );
    // Ascending order — the last write per client wins, i.e. the latest lead.
    for (const l of leadRows) {
      if (l.client_id && l.brand) leadBrandByClient.set(l.client_id, l.brand);
    }
  }

  // Phase 2 context: each let's agreement signature + its raised invoices,
  // plus v2's handling events and the editable rate card. These grow with the
  // let history → page through fetchAllRows past PostgREST's 1000-row cap
  // (stable order + id tiebreaker so windows never skip or repeat rows).
  const letIds = lets.map((l) => l.id);
  const [agreements, invoices, handlingEvents, rates] = await Promise.all([
    letIds.length
      ? fetchAllRows((f, t) =>
          supabase
            .from("signatures")
            .select("storage_let_id, signer_name, channel")
            .eq("kind", "storage")
            .in("storage_let_id", letIds)
            .order("id")
            .range(f, t),
        )
      : Promise.resolve([] as { storage_let_id: string | null; signer_name: string; channel: string }[]),
    letIds.length
      ? fetchAllRows((f, t) =>
          supabase
            .from("storage_invoices")
            .select("id, let_id, period_start, amount, status, kind, zoho_invoice_number, zoho_invoice_url")
            .in("let_id", letIds)
            .order("period_start", { ascending: false })
            .order("id")
            .range(f, t),
        )
      : Promise.resolve([] as never[]),
    letIds.length
      ? fetchAllRows((f, t) =>
          supabase
            .from("storage_handling_events")
            .select("id, let_id, event_date, kind, amount, billed_invoice_id")
            .in("let_id", letIds)
            .order("event_date", { ascending: false })
            .order("id")
            .range(f, t),
        )
      : Promise.resolve([] as never[]),
    getStorageRates(supabase),
  ]);
  const agreementByLet = new Map(
    agreements.filter((a) => a.storage_let_id).map((a) => [a.storage_let_id as string, a]),
  );
  const invoicesByLet = new Map<string, LetInvoice[]>();
  const invoicedStartsByLet = new Map<string, Set<string>>();
  for (const inv of invoices ?? []) {
    const list = invoicesByLet.get(inv.let_id) ?? [];
    if (list.length < 4) {
      list.push({
        id: inv.id,
        period_start: inv.period_start,
        amount: Number(inv.amount),
        status: inv.status,
        kind: inv.kind ?? "period",
        zoho_invoice_number: inv.zoho_invoice_number,
        zoho_invoice_url: inv.zoho_invoice_url,
      });
    }
    invoicesByLet.set(inv.let_id, list);
    const starts = invoicedStartsByLet.get(inv.let_id) ?? new Set<string>();
    starts.add(inv.period_start.slice(0, 10));
    invoicedStartsByLet.set(inv.let_id, starts);
  }
  const eventsByLet = new Map<string, HandlingEventRow[]>();
  for (const ev of handlingEvents ?? []) {
    const list = eventsByLet.get(ev.let_id) ?? [];
    list.push({
      id: ev.id,
      event_date: ev.event_date,
      kind: ev.kind,
      amount: Number(ev.amount),
      billed: ev.billed_invoice_id != null,
    });
    eventsByLet.set(ev.let_id, list);
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const clientName = new Map(clients.map((c) => [c.id, c.display_name as string]));
  const clientEmail = new Map(clients.map((c) => [c.id, (c.email as string | null) ?? null]));
  const letRows: LetRow[] = lets.map((l) => {
    const agr = agreementByLet.get(l.id);
    return {
      ...l,
      rate: l.rate == null ? null : Number(l.rate),
      min_days: l.min_days == null ? null : Number(l.min_days),
      min_amount: l.min_amount == null ? null : Number(l.min_amount),
      billing_model: l.billing_model ?? "period",
      billing_paused: !!l.billing_paused,
      client_name: clientName.get(l.client_id) ?? "Unknown client",
      client_email: clientEmail.get(l.client_id) ?? null,
      agreement: agr ? { signer: agr.signer_name, channel: agr.channel } : null,
      next_invoice: nextInvoiceDateFor(l as BillableLet, invoicedStartsByLet.get(l.id) ?? new Set(), today),
      invoices: invoicesByLet.get(l.id) ?? [],
      handling_events: eventsByLet.get(l.id) ?? [],
    };
  });

  const picker: PickerClient[] = clients.map((c) => ({
    id: c.id,
    name: c.display_name ?? "—",
    phone: ukPhone(c.phone_raw ?? c.phone_e164) ?? null,
    email: c.email ?? null,
    leadBrand: leadBrandByClient.get(c.id) ?? null,
  }));

  // Minimal serialisable brand shape for the client component — satisfies
  // both BrandChipData and BrandFilterOption; keeps brand config (emails,
  // phone numbers, template ids) out of the client payload.
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
      <PageHeader eyebrow="Operations" title="Storage" />
      <StorageView
        sites={(sites ?? []) as SiteRow[]}
        units={(units ?? []) as UnitRow[]}
        lets={letRows}
        clients={picker}
        rates={rates}
        brands={brandOptions}
        brandFilter={brandFilter}
        showBrandChips={multi && brandFilter === "all"}
      />
    </main>
  );
}
