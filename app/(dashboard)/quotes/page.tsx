import Link from "next/link";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getBusinessSettings } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { QuotesView, type QuoteRow } from "@/components/quotes/quotes-view";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

export const dynamic = "force-dynamic";

export default async function QuotesPage() {
  const supabase = await createClient();
  // Unbounded table — page through fetchAllRows (PostgREST truncates at 1000 rows).
  const [quotes, settings] = await Promise.all([
    fetchAllRows((f, t) =>
      supabase
        .from("quotes")
        .select(
          "id, quote_ref, customer_name, collect_addr, dest_addr, grand_total, agreed_price, status, email_send_count, accepted_at, lead_id, created_at, updated_at, deposit_paid_at",
        )
        .order("created_at", { ascending: false })
        .order("id")
        .range(f, t),
    ),
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

      <QuotesView quotes={quotes as QuoteRow[]} defaultDeposit={settings.defaultDeposit} />
    </main>
  );
}
