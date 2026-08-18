import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { likeEscape } from "@/lib/util/like";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BrandMark } from "@/components/app-sidebar";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";
import { previousWeekPeriod, weekPeriodOf } from "@/lib/staff/statements";
import { HoursEditor, type HoursWeek } from "@/components/my-jobs/hours-editor";
import type { TimeEntryDto } from "./actions";

/**
 * /my-jobs/hours — the crew log what hours they actually did, day by day, plus
 * any expense we repay (fuel etc.) with its receipt photo. Filled after the
 * fact — today, tomorrow, or all together at the end of the week — never a
 * punch clock. Feeds the weekly invoice: a logged day seeds its REAL hours
 * instead of the flat 8-hour guess.
 */

export const dynamic = "force-dynamic";

const UK = "Europe/London";

export default async function CrewHoursPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");

  const sb = await createClient();

  // Link login → crew record: explicit profile_id first, then email match
  // (same resolution as every /my-jobs surface, so the link stays consistent).
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
      .ilike("email", likeEscape(profile.email))
      .eq("is_active", true)
      .maybeSingle();
    staffRow = byEmail ?? null;
    if (byEmail) await sb.from("staff").update({ profile_id: profile.id }).eq("id", byEmail.id);
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });
  const thisWeek = weekPeriodOf(today);
  const lastWeek = previousWeekPeriod(today);

  let entries: TimeEntryDto[] = [];
  const jobByDate: Record<string, string> = {};
  let weeks: HoursWeek[] = [];

  if (staffRow) {
    const { data: rows } = await sb
      .from("staff_time_entries")
      .select("work_date, started_at, ended_at, expense_amount, expense_note, receipt_key, receipt_emailed_at")
      .eq("staff_id", staffRow.id)
      .gte("work_date", lastWeek.start)
      .lte("work_date", thisWeek.end);
    entries = (rows ?? []).map((r) => ({
      work_date: r.work_date,
      started_at: r.started_at,
      ended_at: r.ended_at,
      expense_amount: r.expense_amount == null ? null : Number(r.expense_amount),
      expense_note: r.expense_note,
      has_receipt: !!r.receipt_key,
      receipt_emailed: !!r.receipt_emailed_at,
    }));

    // Which jobs they were on each day — a memory prompt on the row, nothing
    // more (hours can be logged on any day; a yard day is real work too).
    // Crew CRM reads are service-role by design (0069), bounded to the staff
    // id resolved from the authenticated session above.
    const admin = createAdminClient();
    const { data: myAssigns } = await admin
      .from("appointment_assignments")
      .select("appointment_id")
      .eq("staff_id", staffRow.id);
    const apptIds = [...new Set((myAssigns ?? []).map((a) => a.appointment_id))];
    if (apptIds.length) {
      const { data: appts } = await admin
        .from("appointments")
        .select("id, starts_at, appt_type, lead_id, status")
        .in("id", apptIds)
        .neq("status", "cancelled");
      const leadIds = [...new Set((appts ?? []).map((a) => a.lead_id).filter(Boolean))] as string[];
      const { data: leads } = leadIds.length
        ? await admin.from("leads").select("id, name").in("id", leadIds)
        : { data: [] as { id: string; name: string | null }[] };
      const leadName = new Map((leads ?? []).map((l) => [l.id, l.name]));
      const labelsByDay = new Map<string, string[]>();
      for (const a of appts ?? []) {
        if (!a.starts_at) continue;
        const day = new Date(a.starts_at).toLocaleDateString("en-CA", { timeZone: UK });
        if (day < lastWeek.start || day > thisWeek.end) continue;
        const who = (a.lead_id ? leadName.get(a.lead_id) : null) ?? "job";
        const label = `${a.appt_type === "removal" ? "Move" : a.appt_type === "pack" ? "Packing" : "Survey"} — ${who}`;
        labelsByDay.set(day, [...(labelsByDay.get(day) ?? []), label]);
      }
      for (const [day, labels] of labelsByDay) {
        jobByDate[day] = labels.length > 1 ? `${labels[0]} (+${labels.length - 1} more)` : labels[0];
      }
    }

    // A week locks once its invoice is SUBMITTED or PAID — the entries are the
    // evidence behind that invoice. A draft doesn't lock.
    const { data: stmts } = await sb
      .from("staff_statements")
      .select("ref, status, period_start, period_end")
      .eq("staff_id", staffRow.id)
      .in("status", ["submitted", "paid"])
      .lte("period_start", thisWeek.end)
      .gte("period_end", lastWeek.start);
    const lockFor = (w: { start: string; end: string }) =>
      (stmts ?? []).find((s) => s.period_start <= w.end && s.period_end >= w.start)?.ref ?? null;

    weeks = [
      { start: thisWeek.start, end: thisWeek.end, label: "This week", lockedRef: lockFor(thisWeek) },
      { start: lastWeek.start, end: lastWeek.end, label: "Last week", lockedRef: lockFor(lastWeek) },
    ];
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
        <p className="eyebrow mt-3">Your hours</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-foreground">What hours did you do?</h1>
        <p className="mt-1.5 text-sm text-mist-400">
          Tap a day, put in your start and finish, and add any fuel or expenses with a photo of the receipt. Fill it
          in daily or catch up before the end of the week — your invoice uses these hours. Need a day older than
          last week? Ask the office.
        </p>

        {!staffRow ? (
          <div className="mt-6 rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-mist-500">
            This login isn&apos;t linked to a crew record yet — ask the office to add you under Staff &amp; Fleet with
            this email address.
          </div>
        ) : (
          <div className="mt-5">
            <HoursEditor initialEntries={entries} today={today} weeks={weeks} jobByDate={jobByDate} />
          </div>
        )}
      </main>
    </div>
  );
}
