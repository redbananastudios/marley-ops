import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";

/**
 * PRs #226/#227 (2026-09-04): `updateLeadStatusAction`'s `reopening` branch
 * (app/(dashboard)/leads/actions.ts, `if (reopening) { ... }`) already cleared
 * the voided Zoho invoice ids on the `quotes` row so the raisers could mint
 * fresh invoices again — but `PaymentsCard` (components/leads/payments-card.tsx,
 * via `app/(dashboard)/leads/[id]/page.tsx`) reads a SEPARATE denormalised copy
 * on the `leads` table: `deposit_amount`/`deposit_requested_at` and
 * `balance_amount`/`balance_due_date`, stamped by the same raise
 * (`lib/quote/accept-flow.ts`) and, before this fix, never cleared by the
 * reopen unwind. A lead reopened after a cancel-and-reopen kept showing
 * "£X requested · unpaid" / "£X invoiced" for documents that no longer existed
 * in the books (869ett5y8 and its deposit-side sibling).
 *
 * This spec seeds a lead in exactly that pre-reopen state — `status='declined'`
 * with stale `leads` money fields AND a `quotes` row still carrying voided
 * invoice ids — then drives the real "Reopen" button
 * (components/leads/lead-action-bar.tsx, only rendered when `status==='declined'`)
 * and asserts both the UI and the DB agree the stale state is gone. Never
 * touches `deposit_paid_at`/`balance_paid_at` (an already-paid rail is never
 * voided by the cancel flow in the first place, so reopen must never touch it
 * either) — asserted as a negative to catch a future clear widened too far.
 *
 * Live-verified against staging 2026-09-04 by the QA audit (a byte-identical
 * scratch fixture: same seed shape, same admin login + Reopen click) before
 * this file was written from that recipe. 0 findings — the fix holds.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports both)
 * to seed/tear down its marker fixture — set in CI, usually unset locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker fixture",
);

const MARKER = `E2E-REOPEN-STALE-${Date.now()}`;

interface Fixture {
  clientId: string;
  leadId: string;
  quoteId: string;
}

async function seed(): Promise<Fixture> {
  const sb = adminClient();
  const now = Date.now();
  const past = (days: number) => new Date(now - days * 86_400_000).toISOString();

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client`, notes: MARKER, postcode_home: "SP7 8AA" })
    .select("id")
    .single();
  if (cErr || !client) throw new Error(`seed client: ${cErr?.message ?? "no row returned"}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      name: `${MARKER} Client`,
      notes: MARKER,
      status: "declined",
      lost_reason: "other",
      lost_note: `${MARKER} seeded lost note`,
      lost_at: past(3),
      chase_paused: true,
      first_contacted_at: past(10),
      entry_channel: "manual",
      source_system: "marley_ops",
      media_consent: "unset",
      deposit_amount: 150,
      deposit_requested_at: past(5),
      balance_amount: 650,
      balance_due_date: past(2),
    })
    .select("id")
    .single();
  if (lErr || !lead) throw new Error(`seed lead: ${lErr?.message ?? "no row returned"}`);

  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      lead_id: lead.id,
      client_id: client.id,
      quote_ref: MARKER,
      // 'accepted' and never flipped back — booking-change.ts's cancel unwind
      // deliberately leaves an ACCEPTED booking's quote status alone (the
      // cancellation marker is booking_cancelled_at, not a status flip; only a
      // pre-acceptance quote flips to 'rejected' on mark-lost). The quotes-side
      // clear this spec also asserts is itself gated on status='accepted' — see
      // the `.eq("status", "accepted")` in the reopen unwind — so seeding
      // 'rejected' here would silently skip that clear and prove nothing.
      status: "accepted",
      subtotal: 800,
      grand_total: 800,
      agreed_price: 800,
      accepted_at: past(8),
      booking_cancelled_at: past(3),
      zoho_deposit_invoice_id: `${MARKER}-dep`,
      zoho_deposit_invoice_number: `${MARKER}-dep-num`,
      zoho_deposit_invoice_url: "https://example.invalid/dep",
      deposit_invoice_provider: "zoho",
      zoho_balance_invoice_id: `${MARKER}-bal`,
      zoho_balance_invoice_number: `${MARKER}-bal-num`,
      zoho_balance_invoice_url: "https://example.invalid/bal",
      balance_invoice_provider: "zoho",
      balance_invoice_amount: 650,
      balance_invoice_created_at: past(5),
      commercial_due_date: past(2),
    })
    .select("id")
    .single();
  if (qErr || !quote) throw new Error(`seed quote: ${qErr?.message ?? "no row returned"}`);

  return { clientId: client.id as string, leadId: lead.id as string, quoteId: quote.id as string };
}

async function teardown(fx: Fixture) {
  const sb = adminClient();
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    problems = [];
    const check = (label: string, error: { message: string } | null) => {
      if (error) problems.push(`${label}: ${error.message}`);
    };
    check("activities", (await sb.from("activities").delete().eq("lead_id", fx.leadId)).error);
    check("quotes", (await sb.from("quotes").delete().eq("id", fx.quoteId)).error);
    check("leads", (await sb.from("leads").delete().eq("id", fx.leadId)).error);
    check("clients", (await sb.from("clients").delete().eq("id", fx.clientId)).error);
    const { count } = await sb.from("clients").select("*", { count: "exact", head: true }).eq("notes", MARKER);
    if (count) problems.push(`clients: ${count} marker row(s) still present after delete`);
    if (!problems.length) return;
    if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

let fx: Fixture | null = null;

test.describe.serial("Office — reopening a declined lead clears stale deposit/balance display", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  test.afterAll(async () => {
    if (fx) await teardown(fx);
  });

  test("Payments card shows the stale requested/invoiced state before reopen", async ({ page }) => {
    await step("open the lead — declined, stale deposit + balance still showing", page, async () => {
      await page.goto(`/leads/${fx!.leadId}`);
      await expect(page.getByRole("heading", { name: `${MARKER} Client` })).toBeVisible();
      await expect(page.getByText("£150")).toBeVisible();
      await expect(page.getByText("£650")).toBeVisible();
      await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
    });
  });

  test("Reopen clears the stale leads.deposit/balance fields and the quote's voided invoice ids", async ({ page }) => {
    await step("click Reopen", page, async () => {
      await page.goto(`/leads/${fx!.leadId}`);
      await page.getByRole("button", { name: "Reopen" }).click();
      await expect(page.getByText(/Reopened/i)).toBeVisible({ timeout: 15_000 });
    });

    await step("UI: the stale £150/£650 figures are gone from the Payments card", page, async () => {
      await expect(page.getByText("£150")).not.toBeVisible();
      await expect(page.getByText("£650")).not.toBeVisible();
    });

    await step("SQL: leads — status left declined, stale money fields cleared, loss record cleared, chase paused", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("leads")
        .select("status, deposit_amount, deposit_requested_at, balance_amount, balance_due_date, deposit_paid_at, balance_paid_at, lost_reason, lost_at, chase_paused")
        .eq("id", fx!.leadId)
        .single();
      expect(error).toBeNull();
      expect(data?.status).not.toBe("declined");
      expect(data?.deposit_amount).toBeNull();
      expect(data?.deposit_requested_at).toBeNull();
      expect(data?.balance_amount).toBeNull();
      expect(data?.balance_due_date).toBeNull();
      expect(data?.lost_reason).toBeNull();
      expect(data?.lost_at).toBeNull();
      expect(data?.chase_paused).toBe(true);
      // Never touched: an already-paid rail must never be cleared by a reopen.
      expect(data?.deposit_paid_at).toBeNull();
      expect(data?.balance_paid_at).toBeNull();
    });

    await step("SQL: quotes — the voided invoice references are dropped so a raiser can mint fresh ones", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("quotes")
        .select("booking_cancelled_at, zoho_deposit_invoice_id, zoho_balance_invoice_id, balance_invoice_amount, commercial_due_date")
        .eq("id", fx!.quoteId)
        .single();
      expect(error).toBeNull();
      expect(data?.booking_cancelled_at).toBeNull();
      expect(data?.zoho_deposit_invoice_id).toBeNull();
      expect(data?.zoho_balance_invoice_id).toBeNull();
      expect(data?.balance_invoice_amount).toBeNull();
      expect(data?.commercial_due_date).toBeNull();
    });
  });
});
