import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  ResourcesView,
  type StaffRow,
  type UnavailabilityRow,
  type VehicleRow,
} from "@/components/resources/resources-view";

export const dynamic = "force-dynamic";

type SearchParams = { tab?: string };

export default async function ResourcesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: staff }, { data: vehicles }, { data: unavailability }] = await Promise.all([
    supabase.from("staff").select("*").order("is_active", { ascending: false }).order("full_name"),
    supabase.from("vehicles").select("*").order("is_active", { ascending: false }).order("name"),
    supabase
      .from("vehicle_unavailability")
      .select("id, vehicle_id, start_date, end_date, reason, note")
      .order("start_date", { ascending: false }),
  ]);

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Operations" title="Staff & Fleet" />
      <ResourcesView
        staff={(staff ?? []) as StaffRow[]}
        vehicles={(vehicles ?? []) as VehicleRow[]}
        unavailability={(unavailability ?? []) as UnavailabilityRow[]}
        initialTab={sp.tab === "vehicles" ? "vehicles" : "staff"}
      />
    </main>
  );
}
