import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, FileSignature } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { StartEstimatorStatement } from "@/components/estimator/start-estimator-statement";
import { periodLabel, previousWeekPeriod, weekPeriodOf } from "@/lib/staff/statements";
import { isSelfBillingEnabled } from "@/lib/staff/self-billing";
import { hasSignedCurrentAgreement } from "@/lib/contractor/status";

/**
 * /estimator/pay — the estimator's own contractor-invoicing surface. Mirrors the
 * crew /my-jobs/pay, but bills survey visits (£50), telephone quotes (£10) and
 * completion commission (7.5%). Estimators see ONLY their own invoices here; the
 * office reviews + pays them at Finance › Contractor pay (admin-only).
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

export default async function EstimatorPayPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "estimator" && profile.role !== "admin") redirect("/");

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

  const signedAgreement = staffRow && enabled ? await hasSignedCurrentAgreement(sb, profile.id) : false;

  let statements: { id: string; ref: string; status: string; period_start: string; period_end: string; total: number; return_reason: string | null }[] = [];
  if (staffRow && enabled && signedAgreement) {
    const { data } = await sb
      .from("staff_statements")
      .select("id, ref, status, period_start, period_end, total, return_reason")
      .eq("staff_id", staffRow.id)
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
    <main className="page-shell">
      <PageHeader eyebrow="Your pay" title="My invoices" />

      {!staffRow ? (
        <div className="mt-2 rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-mist-500">
          Your login isn&apos;t linked to a staff record yet — ask the office to add you under Staff &amp; Fleet with this email
          address.
        </div>
      ) : !enabled ? (
        <div className="mt-2 rounded-lg border border-border bg-card px-5 py-10 text-center text-sm text-mist-500">
          Contractor invoicing isn&apos;t switched on yet. The office will turn it on once the contractor agreement is in place.
        </div>
      ) : !signedAgreement ? (
        <Link
          href="/settings"
          className="focus-ring mt-2 flex max-w-2xl items-start gap-3 rounded-xl border border-mm-red/40 bg-mm-red/5 px-5 py-4 text-left hover:bg-mm-red/10"
        >
          <FileSignature className="mt-0.5 size-6 shrink-0 text-mm-red" strokeWidth={1.75} />
          <span>
            <span className="block text-sm font-semibold text-foreground">Sign your contractor agreement first</span>
            <span className="mt-0.5 block text-sm text-mist-500">
              A one-time signature confirms you work with us as a self-employed contractor. Sign it under Settings › Contractor
              agreement, then you can build and submit invoices.
            </span>
            <span className="mt-2 inline-block text-sm font-semibold text-mm-red">Go to Settings →</span>
          </span>
        </Link>
      ) : (
        <div className="max-w-2xl">
          <p className="text-sm text-mist-500">
            Build a weekly invoice — survey visits (£50), telephone quotes (£10) and commission on jobs completed that week —
            then submit it. No VAT; you&apos;re not VAT registered.
          </p>
          <div className="mt-4">
            <StartEstimatorStatement periods={periods} />
          </div>

          <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-mist-400">Your invoices</h2>
          {statements.length === 0 ? (
            <div className="rounded-lg border border-border bg-card px-5 py-8 text-center text-sm text-mist-500">
              Nothing yet. Start one above for the week you want to bill.
            </div>
          ) : (
            <div className="space-y-2">
              {statements.map((s) => (
                <Link
                  key={s.id}
                  href={`/estimator/pay/${s.id}`}
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
        </div>
      )}
    </main>
  );
}
