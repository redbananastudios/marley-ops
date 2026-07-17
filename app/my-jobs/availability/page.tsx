import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { BrandMark } from "@/components/app-sidebar";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";
import { AvailabilityEditor, type InitialAvailability } from "@/components/my-jobs/availability-editor";

/**
 * /my-jobs/availability — the crew set which days they can work. Phone-first;
 * reached from the "My availability" card on /my-jobs. Feeds the office Job
 * Board's "N/N crew free" capacity strip.
 */

export const dynamic = "force-dynamic";

const UK = "Europe/London";
const WEEKS = 8;

export default async function CrewAvailabilityPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");

  const sb = await createClient();

  // Link login → crew record: explicit profile_id first, then email match
  // (same resolution as /my-jobs, so the link is consistent).
  let { data: staffRow } = await sb
    .from("staff")
    .select("id, full_name")
    .eq("profile_id", profile.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!staffRow && profile.email) {
    const { data: byEmail } = await sb
      .from("staff")
      .select("id, full_name")
      .ilike("email", profile.email)
      .eq("is_active", true)
      .maybeSingle();
    staffRow = byEmail ?? null;
    if (byEmail) await sb.from("staff").update({ profile_id: profile.id }).eq("id", byEmail.id);
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + WEEKS * 7);
  const horizonEnd = horizon.toISOString().slice(0, 10);

  let rows: InitialAvailability[] = [];
  if (staffRow) {
    const { data } = await sb
      .from("staff_availability")
      .select("date, status")
      .eq("staff_id", staffRow.id)
      .gte("date", today)
      .lte("date", horizonEnd);
    rows = (data ?? []).map((r) => ({ date: r.date, status: r.status as "available" | "unavailable" }));
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/8 bg-sidebar px-4 sm:px-5">
        <BrandMark compact href="/my-jobs" />
        <div className="flex items-center gap-1.5">
          <span className="hidden text-sm text-white/55 sm:block">{staffRow?.full_name ?? profile.full_name}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-2xl p-4 pb-10 sm:p-5 md:p-8">
        <Link
          href="/my-jobs"
          className="focus-ring -ml-1 inline-flex items-center gap-1 rounded-md py-1 pr-2 text-sm font-medium text-mist-500 hover:text-foreground"
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
          My jobs
        </Link>
        <p className="eyebrow mt-3">Your availability</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-foreground">When can you work?</h1>

        {!staffRow ? (
          <div className="mt-6 rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-mist-500">
            This login isn&apos;t linked to a crew record yet — ask the office to add you under Staff &amp; Fleet with
            this email address.
          </div>
        ) : (
          <div className="mt-5">
            <AvailabilityEditor initial={rows} today={today} weeks={WEEKS} />
          </div>
        )}
      </main>
    </div>
  );
}
