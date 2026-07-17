import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { PageHeader } from "@/components/page-header";
import {
  ResourcesView,
  type StaffAvailabilityRow,
  type StaffRow,
  type UnavailabilityRow,
  type VehicleRow,
} from "@/components/resources/resources-view";

export const dynamic = "force-dynamic";

type SearchParams = { tab?: string };

export default async function ResourcesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const supabase = await createClient();

  // Availability is shown/edited forward only — a past day off is history.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  const [{ data: staff }, { data: vehicles }, { data: unavailability }, staffAvailability] = await Promise.all([
    supabase.from("staff").select("*").order("is_active", { ascending: false }).order("full_name"),
    supabase.from("vehicles").select("*").order("is_active", { ascending: false }).order("name"),
    supabase
      .from("vehicle_unavailability")
      .select("id, vehicle_id, start_date, end_date, reason, note")
      .order("start_date", { ascending: false }),
    // Paged — availability grows one row per staff per marked day; the plain
    // select would silently cap at 1000 (the recurring PostgREST footgun).
    fetchAllRows((f, t) =>
      supabase.from("staff_availability").select("id, staff_id, date, status, note").gte("date", today).order("date").range(f, t),
    ),
  ]);

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Operations" title="Staff & Fleet" />
      <ResourcesView
        staff={(staff ?? []) as StaffRow[]}
        vehicles={(vehicles ?? []) as VehicleRow[]}
        unavailability={(unavailability ?? []) as UnavailabilityRow[]}
        staffAvailability={(staffAvailability ?? []) as StaffAvailabilityRow[]}
        initialTab={sp.tab === "vehicles" ? "vehicles" : "staff"}
      />
    </main>
  );
}
