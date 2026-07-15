import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ClientsView, type ClientRow } from "@/components/clients/clients-view";
import { AddClientDialog } from "@/components/clients/add-client-dialog";
import { classifySource, type SourceKey } from "@/lib/dashboard/compute";
import { getBusinessSettings } from "@/lib/settings";
import { ukPhone } from "@/lib/phone";
import { fetchAllRows } from "@/lib/supabase/fetch-all";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const supabase = await createClient();
  const { baseLocation } = await getBusinessSettings(supabase);

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
      };
    })
    .sort((x, y) => new Date(y.lastLeadAt ?? 0).getTime() - new Date(x.lastLeadAt ?? 0).getTime());

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Customers" title="Clients">
        <AddClientDialog />
      </PageHeader>
      <ClientsView clients={rows} baseLocation={baseLocation} />
    </main>
  );
}
