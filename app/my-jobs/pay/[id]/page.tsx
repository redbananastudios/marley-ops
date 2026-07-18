import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { BrandMark } from "@/components/app-sidebar";
import { SignOutButton } from "@/components/my-jobs/sign-out-button";
import { StatementEditor } from "@/components/my-jobs/statement-editor";
import { periodLabel, type StatementStatus } from "@/lib/staff/statements";
import { isSelfBillingEnabled } from "@/lib/staff/self-billing";
import type { StatementPdfData } from "@/lib/staff/statement-docdef";

export const dynamic = "force-dynamic";

export default async function CrewStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  const sb = await createClient();

  if (!(await isSelfBillingEnabled())) redirect("/my-jobs/pay");

  // RLS scopes this to the caller's own statement.
  const { data: stmt } = await sb
    .from("staff_statements")
    .select("id, ref, status, period_start, period_end, total, note, return_reason, submitted_at, created_at, staff_id")
    .eq("id", id)
    .maybeSingle();
  if (!stmt) notFound();

  const [{ data: lines }, { data: staffRow }] = await Promise.all([
    sb
      .from("staff_statement_lines")
      .select("id, description, work_date, quantity, unit_amount, amount, source")
      .eq("statement_id", stmt.id)
      .order("sort_index"),
    sb.from("staff").select("full_name, day_rate").eq("id", stmt.staff_id).maybeSingle(),
  ]);

  const staffName = staffRow?.full_name ?? profile.full_name ?? "";
  const lineRows = (lines ?? []).map((l) => ({
    id: l.id,
    description: l.description,
    work_date: l.work_date,
    quantity: l.quantity,
    unit_amount: l.unit_amount,
    amount: Number(l.amount),
    source: l.source,
  }));

  const issued = new Date(stmt.submitted_at ?? stmt.created_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const pdfData: StatementPdfData = {
    ref: stmt.ref,
    staffName,
    periodLabel: `${periodLabel(stmt.period_start, stmt.period_end)} ${new Date(`${stmt.period_end}T12:00:00Z`).getUTCFullYear()}`,
    issuedDate: issued,
    status: stmt.status,
    lines: lineRows.map((l) => ({
      description: l.description,
      work_date: l.work_date,
      quantity: l.quantity,
      unit_amount: l.unit_amount,
      amount: l.amount,
    })),
    total: Number(stmt.total),
    note: stmt.note,
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/8 bg-sidebar px-4 sm:px-5">
        <BrandMark compact href="/my-jobs" />
        <div className="flex items-center gap-1.5">
          <span className="hidden text-sm text-white/55 sm:block">{staffName}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto max-w-2xl p-4 pb-10 sm:p-5 md:p-8">
        <Link
          href="/my-jobs/pay"
          className="focus-ring -ml-1 inline-flex items-center gap-1 rounded-md py-1 pr-2 text-sm font-medium text-mist-500 hover:text-foreground"
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
          My statements
        </Link>
        <p className="eyebrow mt-3">Payment statement</p>
        <h1 className="mt-1 font-display text-3xl font-bold text-foreground">What you&apos;re owed</h1>

        <div className="mt-5">
          <StatementEditor
            statement={{
              id: stmt.id,
              ref: stmt.ref,
              status: stmt.status as StatementStatus,
              period_start: stmt.period_start,
              period_end: stmt.period_end,
              total: Number(stmt.total),
              note: stmt.note,
              return_reason: stmt.return_reason,
            }}
            lines={lineRows}
            pdfData={pdfData}
            dayRate={staffRow?.day_rate == null ? null : Number(staffRow.day_rate)}
          />
        </div>
      </main>
    </div>
  );
}
