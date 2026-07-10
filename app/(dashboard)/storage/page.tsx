import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { ukPhone } from "@/lib/phone";
import {
  StorageView,
  type LetRow,
  type PickerClient,
  type SiteRow,
  type UnitRow,
} from "@/components/storage/storage-view";

export const dynamic = "force-dynamic";

export default async function StoragePage() {
  const supabase = await createClient();

  const [{ data: sites }, { data: units }, lets, clients] = await Promise.all([
    supabase.from("storage_sites").select("*").order("is_active", { ascending: false }).order("name"),
    supabase.from("storage_units").select("*").order("is_active", { ascending: false }).order("code").order("name"),
    // Full let history stays small for a long time (1 site today); page it anyway.
    fetchAllRows((f, t) =>
      supabase
        .from("storage_lets")
        .select("id, unit_id, client_id, start_date, end_date, rate, rate_period, notes")
        .order("id")
        .range(f, t),
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

  const clientName = new Map(clients.map((c) => [c.id, c.display_name as string]));
  const letRows: LetRow[] = lets.map((l) => ({
    ...l,
    rate: l.rate == null ? null : Number(l.rate),
    client_name: clientName.get(l.client_id) ?? "Unknown client",
  }));

  const picker: PickerClient[] = clients.map((c) => ({
    id: c.id,
    name: c.display_name ?? "—",
    phone: ukPhone(c.phone_raw ?? c.phone_e164) ?? null,
    email: c.email ?? null,
  }));

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Operations" title="Storage" />
      <StorageView
        sites={(sites ?? []) as SiteRow[]}
        units={(units ?? []) as UnitRow[]}
        lets={letRows}
        clients={picker}
      />
    </main>
  );
}
