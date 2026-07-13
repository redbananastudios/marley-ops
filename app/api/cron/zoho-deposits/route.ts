import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchQuoteById, syncZohoPayments } from "@/lib/quote/accept-flow";

/**
 * Payment watcher (Vercel cron): polls Zoho for card payments (or payments
 * Connor records directly in Zoho) on open deposit + balance invoices and runs
 * the paid pipeline — lead Confirmed, chase closed, customer confirmation
 * email, ops alert. The accept page does the same check on load, so this cron
 * is the safety net for customers who never revisit their link.
 *
 * Also sweeps stale creation claims: a 'pending' zoho_*_invoice_id older than
 * 15 minutes means a creator crashed mid-flight — reset to NULL so the next
 * trigger retries (reference-number orphan adoption keeps that safe).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!(await requireUserOrCronSecret(req))) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const run = await runCron("zoho-deposits", async () => {
  const sb = createAdminClient();

  // Stale-claim sweep (both invoice slots).
  const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  for (const col of ["zoho_deposit_invoice_id", "zoho_balance_invoice_id"] as const) {
    await sb
      .from("quotes")
      .update({ [col]: null } as never)
      .eq(col, "pending")
      .lt("updated_at", staleCutoff);
  }

  // Open deposit invoices (accepted, unpaid) + open balance invoices.
  const { data: openDeposits } = await sb
    .from("quotes")
    .select("id")
    .eq("status", "accepted")
    .is("deposit_paid_at", null)
    .not("zoho_deposit_invoice_id", "is", null)
    .neq("zoho_deposit_invoice_id", "pending")
    .limit(25);

  const { data: openBalances } = await sb
    .from("quotes")
    .select("id, lead_id")
    .not("zoho_balance_invoice_id", "is", null)
    .neq("zoho_balance_invoice_id", "pending")
    .not("lead_id", "is", null)
    .limit(50);

  // Balance rows are only interesting while the lead's balance is unpaid.
  const balanceLeadIds = [...new Set((openBalances ?? []).map((q) => q.lead_id as string))];
  const unpaidLeads = new Set<string>();
  if (balanceLeadIds.length) {
    const { data: leads } = await sb
      .from("leads")
      .select("id")
      .in("id", balanceLeadIds)
      .is("balance_paid_at", null);
    for (const l of leads ?? []) unpaidLeads.add(l.id);
  }

  const ids = new Set<string>([
    ...(openDeposits ?? []).map((q) => q.id),
    ...(openBalances ?? []).filter((q) => unpaidLeads.has(q.lead_id as string)).map((q) => q.id),
  ]);

  let checked = 0;
  let settled = 0;
  for (const id of ids) {
    const quote = await fetchQuoteById(sb, id);
    if (!quote) continue;
    checked++;
    const after = await syncZohoPayments(sb, quote);
    if (
      (!quote.deposit_paid_at && after.deposit_paid_at) ||
      after.balance_invoice_amount !== quote.balance_invoice_amount
    ) {
      settled++;
    }
  }

  return { checked, settled };
  });
  return NextResponse.json(
    { ok: run.ok, ...(run.summary ?? {}), ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
