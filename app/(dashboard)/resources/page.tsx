import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { listActiveBrandsOrEmpty } from "@/lib/brand";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { PageHeader } from "@/components/page-header";
import {
  ResourcesView,
  type StaffAvailabilityRow,
  type StaffRow,
  type UnavailabilityRow,
  type VehicleRow,
} from "@/components/resources/resources-view";
import type { StaffSubmissionRow } from "@/components/resources/staff-onboarding";

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

  const [{ data: staff }, { data: pay }, { data: vehicles }, { data: unavailability }, staffAvailability, { data: onboardSettings }, { data: submissions }, activeBrands] =
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
      // Public crew sign-up link state + the pending review queue. Fetched for
      // ADMIN ONLY (review 2026-07-29): the UI renders only for admin, and
      // gating the fetch keeps the live token + applicant PII out of an
      // estimator's RSC payload entirely.
      isAdmin
        ? supabase.from("business_settings").select("staff_onboard_enabled, staff_onboard_token").eq("id", true).maybeSingle()
        : Promise.resolve({ data: null }),
      isAdmin
        ? supabase
            .from("staff_submissions")
            .select("id, full_name, date_of_birth, address, email, phone, is_driver, emergency_contact_name, emergency_contact_phone, notes, created_at")
            .eq("status", "pending")
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: null }),
      // Brand layer (multi-brand PRD §4 /resources): livery chips on vehicle
      // cards + the form's livery selector. Single active brand → no brand UI
      // renders (the single-brand invariant, PRD §1).
      listActiveBrandsOrEmpty(supabase),
    ]);

  // Minimal serialisable brand shape for the client component — chip + livery
  // selector only; keeps brand config (emails, phone numbers, template ids)
  // out of the client payload. Empty in single-brand mode so nothing renders.
  const brandOptions =
    activeBrands.length > 1
      ? activeBrands.map((b) => ({
          slug: b.slug,
          name: b.name,
          shortName: b.shortName,
          initial: b.initial,
          colourPrimary: b.colourPrimary,
        }))
      : [];

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
        brands={brandOptions}
        vehicles={(vehicles ?? []) as VehicleRow[]}
        unavailability={(unavailability ?? []) as UnavailabilityRow[]}
        staffAvailability={(staffAvailability ?? []) as StaffAvailabilityRow[]}
        today={today}
        isAdmin={isAdmin}
        initialTab={sp.tab === "vehicles" ? "vehicles" : sp.tab === "availability" ? "availability" : "staff"}
        onboarding={{
          enabled: onboardSettings?.staff_onboard_enabled === true,
          token: onboardSettings?.staff_onboard_token ?? null,
          baseUrl: (process.env.NEXT_PUBLIC_APP_URL || "https://ops.marleymoves.co.uk").replace(/\/$/, ""),
        }}
        pendingSubmissions={(submissions ?? []) as StaffSubmissionRow[]}
      />
    </main>
  );
}
