import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { QuotesView, type QuoteRow } from "@/components/quotes/quotes-view";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

export const dynamic = "force-dynamic";

const QUOTE_COLUMNS =
  "id, quote_ref, customer_name, collect_addr, dest_addr, grand_total, agreed_price, status, email_send_count, accepted_at, lead_id, created_at, updated_at, deposit_paid_at";

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  // Strip the characters that would break the PostgREST or()/ilike filter grammar
  // (commas + parens delimit conditions; %/* are wildcards). Refs, names and
  // postcodes never legitimately contain these.
  const term = query.replace(/[,()%*\\"]/g, "").trim();

  const supabase = await createClient();

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
      return q.order("created_at", { ascending: false }).order("id").range(f, t);
    }),
    getBusinessSettings(supabase),
  ]);

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
      />
    </main>
  );
}
