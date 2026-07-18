import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/app-sidebar";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";
import { StartStatement } from "@/components/my-jobs/start-statement";
import { periodLabel, previousWeekPeriod, weekPeriodOf } from "@/lib/staff/statements";
import { isSelfBillingEnabled } from "@/lib/staff/self-billing";

/**
 * /my-jobs/pay — the crew self-billing surface. Crew build a payment statement
 * for a week, add lines (free description — worked days, retainer, extras) and
 * submit. Dark until business_settings.self_billing_enabled is on (the signed
 * self-billing agreement is the go-live gate).
 */

export const dynamic = "force-dynamic";
const UK = "Europe/London";
const gbp = (n: number): string => "£" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const STATUS_META: Record<string, string> = {
  draft: "bg-muted text-mist-500",
  submitted: "bg-survey-bg text-survey-deep",
  paid: "bg-success-bg text-success",
  void: "bg-muted text-mist-400 line-through",
};

export default async function CrewPayPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  const sb = await createClient();

  const enabled = await isSelfBillingEnabled();

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

  let statements: {
    id: string;
    ref: string;
    status: string;
    period_start: string;
    period_end: string;
    total: number;
    return_reason: string | null;
  }[] = [];
  if (staffRow && enabled) {
    const { data } = await sb
      .from("staff_statements")
      .select("id, ref, status, period_start, period_end, total, return_reason")
      .order("period_start", { ascending: false });
    statements = data ?? [];
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: UK });
  const last = previousWeekPeriod(today);
  const thisW = weekPeriodOf(today);
  const periods = [
    { key: "last", label: `Last week · ${periodLabel(last.start, last.end)}`, start: last.start, end: last.end },
    { key: "this", label: `This week · ${periodLabel(thisW.start, thisW.end)}`, start: thisW.start, end: thisW.end },
  ];

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
        <p className="eyebrow mt-3">Your pay</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-foreground">My statements</h1>

        {!staffRow ? (
          <div className="mt-6 rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-mist-500">
            This login isn&apos;t linked to a crew record yet — ask the office to add you under Staff &amp; Fleet with this
            email address.
          </div>
        ) : !enabled ? (
          <div className="mt-6 rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-mist-500">
            Self-billing isn&apos;t switched on yet. The office will turn it on once the self-billing agreement is in place.
          </div>
        ) : (
          <>
            <p className="mt-4 text-sm text-mist-500">
              Build a statement for what you&apos;re owed, then submit it. No VAT — you&apos;re not VAT registered.
            </p>
            <div className="mt-4">
              <StartStatement periods={periods} />
            </div>

            <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-mist-400">Your statements</h2>
            {statements.length === 0 ? (
              <div className="rounded-lg border border-border bg-card px-5 py-8 text-center text-sm text-mist-500">
                Nothing yet. Start one above for the week you want to bill.
              </div>
            ) : (
              <div className="space-y-2">
                {statements.map((s) => (
                  <Link
                    key={s.id}
                    href={`/my-jobs/pay/${s.id}`}
                    className="focus-ring flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:border-mm-red/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground">{periodLabel(s.period_start, s.period_end)}</p>
                      <p className="text-xs text-mist-400">Ref {s.ref}</p>
                    </div>
                    <span className="text-sm font-semibold tabular text-foreground">{gbp(s.total)}</span>
                    {s.status === "draft" && s.return_reason ? (
                      <span className="rounded-pill bg-warn-bg px-2.5 py-1 text-[11px] font-semibold text-warn">Changes requested</span>
                    ) : (
                      <span className={cn("rounded-pill px-2.5 py-1 text-[11px] font-semibold capitalize", STATUS_META[s.status] ?? "bg-muted text-mist-500")}>
                        {s.status}
                      </span>
                    )}
                    <ChevronRight className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
