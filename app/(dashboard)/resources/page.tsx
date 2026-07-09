import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { ResourcesView, type StaffRow, type VehicleRow } from "@/components/resources/resources-view";

export const dynamic = "force-dynamic";

type SearchParams = { tab?: string };

export default async function ResourcesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: staff }, { data: vehicles }] = await Promise.all([
    supabase.from("staff").select("*").order("is_active", { ascending: false }).order("full_name"),
    supabase.from("vehicles").select("*").order("is_active", { ascending: false }).order("name"),
  ]);

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Operations" title="Staff & Fleet" />
      <ResourcesView
        staff={(staff ?? []) as StaffRow[]}
        vehicles={(vehicles ?? []) as VehicleRow[]}
        initialTab={sp.tab === "vehicles" ? "vehicles" : "staff"}
      />
    </main>
  );
}
