import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
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
  // Crew pay rates are admin-only. RLS already returns no staff_pay rows to an
  // estimator; this flag also hides the rate UI (card line + form fields).
  const profile = await getSessionProfile();
  const isAdmin = profile?.role === "admin";

  // Availability is shown/edited forward only — a past day off is history.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  const [{ data: staff }, { data: pay }, { data: vehicles }, { data: unavailability }, staffAvailability] =
    await Promise.all([
      supabase.from("staff").select("*").order("is_active", { ascending: false }).order("full_name"),
      // Pay is office-scoped (staff_pay); merged in below so a crew page never
      // carries rate data.
      supabase.from("staff_pay").select("staff_id, hourly_rate, weekly_guarantee"),
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

  const payById = new Map((pay ?? []).map((p) => [p.staff_id, p]));
  const staffRows = (staff ?? []).map((s) => {
    const p = payById.get(s.id);
    return {
      ...s,
      hourly_rate: p?.hourly_rate == null ? null : Number(p.hourly_rate),
      weekly_guarantee: p?.weekly_guarantee == null ? null : Number(p.weekly_guarantee),
    };
  }) as StaffRow[];

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Operations" title="Staff & Fleet" />
      <ResourcesView
        staff={staffRows}
        vehicles={(vehicles ?? []) as VehicleRow[]}
        unavailability={(unavailability ?? []) as UnavailabilityRow[]}
        staffAvailability={(staffAvailability ?? []) as StaffAvailabilityRow[]}
        today={today}
        isAdmin={isAdmin}
        initialTab={sp.tab === "vehicles" ? "vehicles" : sp.tab === "availability" ? "availability" : "staff"}
      />
    </main>
  );
}
