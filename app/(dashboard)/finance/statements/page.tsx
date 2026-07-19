import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { PageHeader } from "@/components/page-header";
import { OfficeStatementsView, type OfficeStatement } from "@/components/finance/office-statements-view";
import { periodLabel } from "@/lib/staff/statements";
import type { StatementPdfData } from "@/lib/staff/statement-docdef";

export const dynamic = "force-dynamic";

export default async function ContractorPayPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  // Admin-only: this reviews + pays EVERY contractor (crew + estimators). An
  // estimator must never see crew pay or reach the pay/return controls for their
  // own invoice — they manage only their own at /estimator/pay.
  if (profile.role === "estimator") redirect("/estimator/pay");
  if (profile.role !== "admin") redirect("/my-jobs");

  const sb = await createClient();
  const { data: settings } = await sb.from("business_settings").select("self_billing_enabled").maybeSingle();

  const statements = await fetchAllRows((f, t) =>
    sb
      .from("staff_statements")
      .select("id, staff_id, ref, status, period_start, period_end, total, note, submitted_at, created_at, paid_at, paid_method, paid_ref")
      .order("period_start", { ascending: false })
      .range(f, t),
  );

  const staffIds = [...new Set(statements.map((s) => s.staff_id))];
  const stmtIds = statements.map((s) => s.id);
  const [{ data: staff }, lines] = await Promise.all([
    staffIds.length ? sb.from("staff").select("id, full_name").in("id", staffIds) : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    stmtIds.length
      ? fetchAllRows((f, t) =>
          sb
            .from("staff_statement_lines")
            .select("id, statement_id, description, work_date, quantity, unit_amount, amount")
            .in("statement_id", stmtIds)
            .order("sort_index")
            .range(f, t),
        )
      : Promise.resolve([] as { id: string; statement_id: string; description: string; work_date: string | null; quantity: number | null; unit_amount: number | null; amount: number }[]),
  ]);
  const nameById = new Map((staff ?? []).map((s) => [s.id, s.full_name]));
  const linesByStmt = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = linesByStmt.get(l.statement_id) ?? [];
    list.push(l);
    linesByStmt.set(l.statement_id, list);
  }

  const rows: OfficeStatement[] = statements.map((s) => {
    const staffName = nameById.get(s.staff_id) ?? "Contractor";
    const myLines = (linesByStmt.get(s.id) ?? []).map((l) => ({
      description: l.description,
      work_date: l.work_date,
      quantity: l.quantity,
      unit_amount: l.unit_amount,
      amount: Number(l.amount),
    }));
    const issued = new Date(s.submitted_at ?? s.created_at).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const pdf: StatementPdfData = {
      ref: s.ref,
      staffName,
      periodLabel: `${periodLabel(s.period_start, s.period_end)} ${new Date(`${s.period_end}T12:00:00Z`).getUTCFullYear()}`,
      issuedDate: issued,
      status: s.status,
      lines: myLines,
      total: Number(s.total),
      note: s.note,
    };
    return {
      id: s.id,
      ref: s.ref,
      staffName,
      status: s.status,
      period_start: s.period_start,
      period_end: s.period_end,
      total: Number(s.total),
      paid_method: s.paid_method,
      paid_ref: s.paid_ref,
      pdf,
    };
  });

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Finance" title="Contractor pay" />
      <OfficeStatementsView statements={rows} enabled={!!settings?.self_billing_enabled} />
    </main>
  );
}
