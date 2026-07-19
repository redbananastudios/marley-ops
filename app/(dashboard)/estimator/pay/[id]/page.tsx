import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { EstimatorStatementEditor } from "@/components/estimator/estimator-statement-editor";
import { periodLabel, type StatementStatus } from "@/lib/staff/statements";
import { isSelfBillingEnabled } from "@/lib/staff/self-billing";
import type { StatementPdfData } from "@/lib/staff/statement-docdef";

export const dynamic = "force-dynamic";

export default async function EstimatorStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "estimator" && profile.role !== "admin") redirect("/");
  if (!(await isSelfBillingEnabled())) redirect("/estimator/pay");

  const sb = await createClient();

  // My own staff row — the invoice must belong to it (an estimator is is_office so
  // RLS would otherwise let them open any statement; this scopes it to theirs).
  const { data: myStaff } = await sb
    .from("staff")
    .select("id, full_name")
    .eq("profile_id", profile.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!myStaff) redirect("/estimator/pay");

  const { data: stmt } = await sb
    .from("staff_statements")
    .select("id, ref, status, period_start, period_end, total, note, return_reason, submitted_at, created_at, staff_id")
    .eq("id", id)
    .maybeSingle();
  if (!stmt || stmt.staff_id !== myStaff.id) notFound();

  const { data: lines } = await sb
    .from("staff_statement_lines")
    .select("id, description, work_date, quantity, unit_amount, amount, source")
    .eq("statement_id", stmt.id)
    .order("sort_index");

  const lineRows = (lines ?? []).map((l) => ({
    id: l.id,
    description: l.description,
    work_date: l.work_date,
    quantity: l.quantity,
    unit_amount: l.unit_amount,
    amount: Number(l.amount),
    source: l.source,
  }));

  const issued = new Date(stmt.submitted_at ?? stmt.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const pdfData: StatementPdfData = {
    ref: stmt.ref,
    staffName: myStaff.full_name ?? profile.full_name ?? "",
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
    <main className="page-shell max-w-2xl">
      <Link
        href="/estimator/pay"
        className="focus-ring -ml-1 inline-flex items-center gap-1 rounded-md py-1 pr-2 text-sm font-medium text-mist-500 hover:text-foreground"
      >
        <ChevronLeft className="size-4" strokeWidth={1.75} />
        My invoices
      </Link>
      <PageHeader eyebrow="Contractor invoice" title="What you're owed" />

      <EstimatorStatementEditor
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
      />
    </main>
  );
}
