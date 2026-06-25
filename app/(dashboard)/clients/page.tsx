import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ClientsView, type ClientRow } from "@/components/clients/clients-view";
import { AddClientDialog } from "@/components/clients/add-client-dialog";
import { classifySource, type SourceKey } from "@/lib/dashboard/compute";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const supabase = await createClient();

  const [{ data: clients }, { data: leads }] = await Promise.all([
    supabase
      .from("clients")
      .select("id, display_name, email, phone_e164, phone_raw, postcode_home, created_at")
      .is("merged_into_id", null)
      .eq("is_active", true),
    supabase
      .from("leads")
      .select(
        "client_id, submitted_at, created_at, entry_channel, gclid, gbraid, wbraid, fbclid, utm_source, utm_medium",
      ),
  ]);

  // per-client: lead count, last enquiry, and first-touch origin (earliest lead's source)
  type Agg = { count: number; last: number; firstTs: number; origin: SourceKey };
  const agg = new Map<string, Agg>();
  for (const l of leads ?? []) {
    if (!l.client_id) continue;
    const ts = new Date(l.submitted_at || l.created_at || 0).getTime();
    const cur = agg.get(l.client_id);
    const source = classifySource(l);
    if (!cur) {
      agg.set(l.client_id, { count: 1, last: ts, firstTs: ts, origin: source });
    } else {
      cur.count += 1;
      if (ts > cur.last) cur.last = ts;
      if (ts < cur.firstTs) {
        cur.firstTs = ts;
        cur.origin = source; // first-touch acquisition channel
      }
    }
  }

  const rows: ClientRow[] = (clients ?? [])
    .map((c) => {
      const a = agg.get(c.id);
      return {
        id: c.id,
        display_name: c.display_name,
        email: c.email,
        phone: c.phone_e164 ?? c.phone_raw,
        postcode: c.postcode_home,
        leadCount: a?.count ?? 0,
        lastLeadAt: a?.last ? new Date(a.last).toISOString() : c.created_at,
        // No leads → manually-added client; show Manual origin.
        origin: a?.origin ?? "manual",
      };
    })
    .sort((x, y) => new Date(y.lastLeadAt ?? 0).getTime() - new Date(x.lastLeadAt ?? 0).getTime());

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Clients">
        <AddClientDialog />
      </PageHeader>
      <ClientsView clients={rows} />
    </main>
  );
}
