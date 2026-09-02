import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { QuotesView, type QuoteRow } from "@/components/quotes/quotes-view";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { listActiveBrandsOrEmpty } from "@/lib/brand";
import { applyBrandFilter, parseBrandParam } from "@/lib/brand-filter";

export const dynamic = "force-dynamic";

const QUOTE_COLUMNS =
  "id, quote_ref, brand, customer_name, collect_addr, dest_addr, grand_total, agreed_price, status, email_send_count, email_sent_at, accepted_at, lead_id, created_at, updated_at, deposit_paid_at";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; brand?: string }>;
}) {
  const sp = await searchParams;
  const query = (sp.q ?? "").trim();
  // Strip the characters that would break the PostgREST or()/ilike filter grammar
  // (commas + parens delimit conditions; %/* are wildcards). Refs, names and
  // postcodes never legitimately contain these.
  const term = query.replace(/[,()%*\\"]/g, "").trim();

  const supabase = await createClient();

  // Brand layer (multi-brand PRD §4 Quotes): with a single active brand no
  // brand UI renders and the page is unchanged (the single-brand invariant,
  // PRD §1). The ?brand= filter narrows the quotes query itself, so the 4
  // summary tiles recompute for the filtered brand — "Win rate" means that
  // brand's win rate — not just the visible list.
  const activeBrands = await listActiveBrandsOrEmpty(supabase);
  const multi = activeBrands.length > 1;
  const brandFilter = parseBrandParam(sp, activeBrands);

  // Server-side search across the WHOLE table (not just the visible page). Ref
  // and address text match directly on quotes; name/postcode go through the lead
  // join — resolve the matching lead ids first, then quotes whose ref/name/address
  // matches OR whose lead is in that set. Two round-trips, but simple and correct.
  //
  // The id list is CAPPED at 100 most-recent leads: PostgREST reads are GETs, so
  // every id rides the request URL and ~200 uuids would cross the gateway's 8KB
  // header limit — the query would 414 and the page would silently show "no
  // matches" (review finding, 2026-07-14). A term matching >100 leads is a
  // too-broad search anyway; the direct ref/name/address matches are unaffected.
  let leadIds: string[] = [];
  if (term) {
    const like = `%${term}%`;
    const { data: matchedLeads } = await supabase
      .from("leads")
      .select("id")
      .or(`name.ilike.${like},from_postcode.ilike.${like},to_postcode.ilike.${like}`)
      .order("created_at", { ascending: false })
      .limit(100);
    leadIds = (matchedLeads ?? []).map((l) => l.id);
  }

  // Unbounded table — page through fetchAllRows (PostgREST truncates at 1000 rows).
  const [quotes, settings] = await Promise.all([
    fetchAllRows((f, t) => {
      let q = supabase.from("quotes").select(QUOTE_COLUMNS);
      if (term) {
        const like = `%${term}%`;
        const orParts = [
          `quote_ref.ilike.${like}`,
          `customer_name.ilike.${like}`,
          // Street/town free text lives on the quote itself — the pre-search
          // client filter matched these, so keep parity with what users expect.
          `collect_addr.ilike.${like}`,
          `dest_addr.ilike.${like}`,
        ];
        if (leadIds.length) orParts.push(`lead_id.in.(${leadIds.join(",")})`);
        q = q.or(orParts.join(","));
      }
      q = applyBrandFilter(q, brandFilter);
      return q.order("created_at", { ascending: false }).order("id").range(f, t);
    }),
    getBusinessSettings(supabase),
  ]);

  // Minimal serialisable brand shape for the client view — satisfies both
  // BrandChipData and BrandFilterOption; keeps brand config (emails, phone
  // numbers, template ids) out of the client payload. Same pattern as /leads.
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
      <PageHeader eyebrow="Sales" title="Quotes">
        <Button asChild>
          <Link href="/quotes/new" prefetch={false}>
            <Plus strokeWidth={1.75} />
            New quote
          </Link>
        </Button>
      </PageHeader>

      <QuotesView
        quotes={quotes as QuoteRow[]}
        defaultDeposit={settings.defaultDeposit}
        query={query}
        brands={brandOptions}
        showBrandChips={multi && brandFilter === "all"}
      />
    </main>
  );
}
