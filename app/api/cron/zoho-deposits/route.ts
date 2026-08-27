import { NextResponse } from "next/server";
import { requireUserOrCronSecret } from "@/lib/api-auth";
import { runCron } from "@/lib/cron/run-logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchQuoteById, syncZohoPayments } from "@/lib/quote/accept-flow";

/**
 * Payment watcher (Vercel cron): polls Zoho for card payments (or payments
 * Connor records directly in Zoho) on open deposit + commitment + balance
 * invoices and runs the paid pipeline — lead Confirmed, chase closed, customer
 * confirmation email, ops alert. The accept page does the same check on load,
 * so this cron is the safety net for customers who never revisit their link.
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

  // Stale-claim sweep (all three invoice slots).
  const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  for (const col of [
    "zoho_deposit_invoice_id",
    "zoho_balance_invoice_id",
    "zoho_commitment_invoice_id",
  ] as const) {
    await sb
      .from("quotes")
      .update({ [col]: null } as never)
      .eq(col, "pending")
      .lt("updated_at", staleCutoff);
  }

  // Open deposit invoices (accepted, unpaid) + open commitment invoices +
  // open balance invoices.
  const { data: openDeposits } = await sb
    .from("quotes")
    .select("id")
    .eq("status", "accepted")
    .is("deposit_paid_at", null)
    .not("zoho_deposit_invoice_id", "is", null)
    .neq("zoho_deposit_invoice_id", "pending")
    .limit(25);

  const { data: openCommitments } = await sb
    .from("quotes")
    .select("id")
    .eq("status", "accepted")
    .is("commitment_paid_at", null)
    .not("zoho_commitment_invoice_id", "is", null)
    .neq("zoho_commitment_invoice_id", "pending")
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
    ...(openCommitments ?? []).map((q) => q.id),
    ...(openBalances ?? []).filter((q) => unpaidLeads.has(q.lead_id as string)).map((q) => q.id),
  ]);

  let checked = 0;
  let settled = 0;
  let unreadable = 0;
  let accessDenied = false;
  for (const id of ids) {
    const quote = await fetchQuoteById(sb, id);
    if (!quote) continue;
    checked++;
    const sync = await syncZohoPayments(sb, quote);
    const after = sync.quote;
    unreadable += sync.unreadable;
    accessDenied ||= sync.accessDenied;
    if (
      (!quote.deposit_paid_at && after.deposit_paid_at) ||
      (!quote.commitment_paid_at && after.commitment_paid_at) ||
      after.balance_invoice_amount !== quote.balance_invoice_amount
    ) {
      settled++;
    }
  }

  // `settled: 0` is only good news if the invoices were actually READ. A
  // lock-out is permanent until a human clears it, so report the run as failed
  // rather than letting a green row imply nothing had been paid: runCron turns
  // `ok: false` into an error row + an operational issue, and the watchdog then
  // pages on the missing fresh success. Transient unreadables stay a green run
  // with a visible count — they genuinely do clear on the next pass.
  return accessDenied
    ? { ok: false, error: "Zoho denied access — invoice states could not be read", checked, settled, unreadable }
    : { ok: true, checked, settled, unreadable };
  });
  return NextResponse.json(
    // Summary first: it carries its own `ok`, and runCron's verdict is the
    // authoritative one, so it must win the spread rather than be overwritten.
    { ...(run.summary ?? {}), ok: run.ok, ...(run.error ? { error: run.error } : {}) },
    { status: run.status },
  );
}
