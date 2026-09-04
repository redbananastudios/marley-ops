import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { openDialog } from "../fixtures/ui";

/**
 * Closes `spec_gaps.admin_ledger_void_routing_spec` (qa/state.json, open since
 * 2026-08-27, code+SQL spot-checked three times but never had a permanent spec).
 *
 * The invariant under test: `markLeadLostAction` (app/(dashboard)/leads/actions.ts
 * ~line 900-985) voids an accepted quote's unpaid deposit invoice via
 * `voidInvoice(id, asProvider(q.deposit_invoice_provider))` — reading back
 * whatever `lib/quote/accept-flow.ts`'s `ensureDepositInvoice` stamped at raise
 * time. If those two ever disagree (a write site stamps the wrong provider, or
 * this read site stops reading it), the void call targets the WRONG ledger
 * SDK, throws, and the catch block only emails an internal ops alert — the
 * booking shows cancelled in the app while the real Zoho invoice stays live.
 * That failure mode is silent to every UI surface, so this proves the SUCCESS
 * path leaves the evidence it should (the "voided" activities note) rather than
 * the failure path's (an ops alert with no matching note).
 *
 * Self-seeds a marker client/lead(quoted)/quote(sent, £100 deposit, 21 days
 * out — comfortably outside the ≤7-day late-booking collapse, same choice as
 * customer-accept-to-bookings.spec.ts) and drives the REAL money path: the
 * customer accepts via /q/<token> (bank transfer — no card SDK needed), which
 * raises a genuine staging-Zoho deposit invoice and stamps
 * deposit_invoice_provider via ensureDepositInvoice. The office then marks the
 * lead lost via the real "Mark lost" dialog, which is offered on a
 * status='provisional' lead per components/leads/lead-action-bar.tsx (quote
 * accepted, deposit unpaid) and fires the exact code path above.
 *
 * Live-verified end to end against staging 2026-09-04 by the QA audit (a
 * byte-identical scratch runner: same seed shape, same customer-accept step,
 * same admin login + Mark lost click) before this file was written from that
 * recipe — deposit invoice INV-000894 (id 1179234000000178255) raised with
 * deposit_invoice_provider='zoho', mark-lost toast read "Marked lost. 1 unpaid
 * invoice voided in Zoho.", and the activities table carried the voided note
 * exactly as asserted below. 0 findings — the provider-routing invariant held.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports both)
 * to seed/tear down its marker fixture — set in CI, usually unset locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker fixture",
);

const MARKER = `E2E-LEDGER-VOID-${Date.now()}`;
const ACCEPT_TOKEN = `${MARKER}-token`.toLowerCase();

interface Fixture {
  clientId: string;
  leadId: string;
  quoteId: string;
  quoteRef: string;
}

async function seed(): Promise<Fixture> {
  const sb = adminClient();
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
      status: "quoted",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} Client`,
      phone: "07700900111",
      email: "qa-sentinel-sink@marleymoves.test",
      from_address: "1 Test Street, Shaftesbury",
      from_postcode: "SP7 8AA",
      to_address: "2 Sample Road, Gillingham",
      to_postcode: "SP8 4AB",
      property_size: "3 bedroom",
      notes: MARKER,
    })
    .select("id")
    .single();
  if (lErr || !lead) throw new Error(`seed lead: ${lErr?.message ?? "no row returned"}`);

  const quoteRef = MARKER;
  const movingDate = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: quoteRef,
      client_id: client.id,
      lead_id: lead.id,
      customer_name: `${MARKER} Client`,
      customer_email: "qa-sentinel-sink@marleymoves.test",
      customer_phone: "07700900111",
      subtotal: 1400,
      grand_total: 1400,
      status: "sent",
      moving_date: movingDate,
      deposit_amount: 100,
      accept_token: ACCEPT_TOKEN,
      email_sent_at: new Date(Date.now() - 86_400_000).toISOString(),
      collect_addr: "1 Test Street, Shaftesbury, SP7 8AA",
      dest_addr: "2 Sample Road, Gillingham, SP8 4AB",
      vat_enabled: true,
      breakdown: { vehicle: "1luton", totalMiles: 20 },
      state_blob: { seeded: MARKER },
    })
    .select("id")
    .single();
  if (qErr || !quote) throw new Error(`seed quote: ${qErr?.message ?? "no row returned"}`);

  return { clientId: client.id as string, leadId: lead.id as string, quoteId: quote.id as string, quoteRef };
}

async function teardown(fx: Fixture) {
  const sb = adminClient();
  // Same two-attempt shape as customer-accept-to-bookings.spec.ts: the accept
  // + mark-lost actions both keep writing child rows (signatures, activities)
  // after their own status flip, so a teardown racing that tail can see a
  // child reappear between deletes and trip the leads/clients FK.
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    problems = [];
    const check = (label: string, error: { message: string } | null) => {
      if (error) problems.push(`${label}: ${error.message}`);
    };
    check("activities", (await sb.from("activities").delete().eq("lead_id", fx.leadId)).error);
    check("signatures", (await sb.from("signatures").delete().eq("lead_id", fx.leadId)).error);
    check("follow_ups", (await sb.from("follow_ups").delete().eq("lead_id", fx.leadId)).error);
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

test.describe.serial("Office — ledger void-on-cancel provider routing", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  test.afterAll(async () => {
    if (fx) await teardown(fx);
  });

  test("customer accepts (bank transfer) — raises a real deposit invoice, stamps its provider", async ({ browser }) => {
    const customerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const customerPage = await customerContext.newPage();
    try {
      await step("accept the marker quote via /q/<token>", customerPage, async () => {
        await customerPage.goto(`/q/${ACCEPT_TOKEN}`);
        await customerPage.waitForLoadState("networkidle");
        const boxes = customerPage.getByRole("checkbox");
        const n = await boxes.count();
        for (let i = 0; i < n; i++) await boxes.nth(i).check();
        await customerPage.getByLabel("Your full name").fill("E2E Ledger Void Customer");
        const acceptBtn = customerPage.getByRole("button", { name: /Accept quote & pay/i });
        for (let attempt = 1; attempt <= 3; attempt++) {
          await acceptBtn.click().catch(() => {});
          try {
            await customerPage.getByText(/deposit to secure your date/i).waitFor({ state: "visible", timeout: 20_000 });
            return;
          } catch {
            if (attempt === 3) throw new Error("accept never reached the pay screen");
            await customerPage.waitForLoadState("networkidle").catch(() => {});
            for (let i = 0; i < n; i++) await boxes.nth(i).check().catch(() => {});
            await customerPage.getByLabel("Your full name").fill("E2E Ledger Void Customer").catch(() => {});
          }
        }
      });

      await step("DB: the accept raised a real deposit invoice, provider stamped zoho", customerPage, async () => {
        const sb = adminClient();
        // ensureDepositInvoice runs inline in acceptQuoteOnline, but allow a
        // short poll for the outbound Zoho round-trip to land.
        let row: { status: string; zoho_deposit_invoice_id: string | null; deposit_invoice_provider: string | null } | null = null;
        for (let i = 0; i < 10; i++) {
          const { data, error } = await sb
            .from("quotes")
            .select("status, zoho_deposit_invoice_id, deposit_invoice_provider")
            .eq("id", fx!.quoteId)
            .single();
          expect(error).toBeNull();
          row = data;
          if (row?.zoho_deposit_invoice_id && row.zoho_deposit_invoice_id !== "pending") break;
          await new Promise((r) => setTimeout(r, 1500));
        }
        expect(row?.status).toBe("accepted");
        expect(row?.zoho_deposit_invoice_id).toBeTruthy();
        expect(row?.zoho_deposit_invoice_id).not.toBe("pending");
        // The provider-routing invariant, write-side: ensureDepositInvoice
        // stamps the configured provider in the SAME write as the invoice id.
        expect(row?.deposit_invoice_provider).toBe("zoho");
      });
    } finally {
      await customerContext.close();
    }
  });

  test("office marks it lost — deposit invoice voided against the STAMPED provider, activity logged, no silent failure", async ({ page }) => {
    let depositInvoiceId: string | null = null;
    let depositInvoiceNumber: string | null = null;

    await step("open the lead — it's provisional (accepted, deposit unpaid)", page, async () => {
      const sb = adminClient();
      const { data } = await sb
        .from("quotes")
        .select("zoho_deposit_invoice_id, zoho_deposit_invoice_number")
        .eq("id", fx!.quoteId)
        .single();
      depositInvoiceId = data?.zoho_deposit_invoice_id ?? null;
      depositInvoiceNumber = data?.zoho_deposit_invoice_number ?? null;
      expect(depositInvoiceId).toBeTruthy();

      await page.goto(`/leads/${fx!.leadId}`);
      await expect(page.getByRole("heading", { name: `${MARKER} Client` })).toBeVisible();
    });

    await step("Mark lost — reason-gated dialog (same flow as mark-lost.spec.ts)", page, async () => {
      const dialog = await openDialog(page, page.getByRole("button", { name: "Mark lost" }).first());
      await dialog.getByRole("button", { name: "Move fell through" }).click();
      const confirm = dialog.getByRole("button", { name: "Mark lost" });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      // The toast names the void explicitly — proof the SUCCESS branch ran,
      // not the catch's silent ops-alert-only failure path.
      await expect(page.getByText(/unpaid invoice voided in Zoho/i)).toBeVisible({ timeout: 15_000 });
    });

    await step("SQL: the invoice id is UNCHANGED (never nulled), booking_cancelled_at stamped", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("quotes")
        .select("zoho_deposit_invoice_id, booking_cancelled_at, status")
        .eq("id", fx!.quoteId)
        .single();
      expect(error).toBeNull();
      expect(data?.zoho_deposit_invoice_id).toBe(depositInvoiceId);
      expect(data?.booking_cancelled_at).toBeTruthy();
      // Pre-acceptance quotes flip to 'rejected' on mark-lost; this one is
      // already 'accepted' and the code deliberately leaves that status alone
      // (the cancellation marker is booking_cancelled_at, not a status flip).
      expect(data?.status).toBe("accepted");
    });

    await step("SQL: leads.status='declined', and the void succeeded — the 'voided' activities note exists", page, async () => {
      const sb = adminClient();
      const { data: lead, error: leadErr } = await sb
        .from("leads")
        .select("status, lost_reason")
        .eq("id", fx!.leadId)
        .single();
      expect(leadErr).toBeNull();
      expect(lead?.status).toBe("declined");
      expect(lead?.lost_reason).toBe("move_fell_through");

      const { data: acts, error: actErr } = await sb
        .from("activities")
        .select("type, summary, meta")
        .eq("lead_id", fx!.leadId)
        .order("created_at");
      expect(actErr).toBeNull();

      // THE assertion this whole spec exists for: a "voided" note naming this
      // exact invoice id/number. Its absence — with only the status_change row
      // present — is exactly what the try/catch's failure branch would leave:
      // the catch never writes this row, only sendOpsAlert (an email, not a
      // DB row a spec can see) fires instead.
      const voidedNote = (acts ?? []).find(
        (a) => a.type === "note" && typeof a.summary === "string" && /voided/i.test(a.summary),
      );
      expect(voidedNote, `expected a 'voided' activities note; got: ${JSON.stringify(acts)}`).toBeTruthy();
      expect(voidedNote!.summary).toContain(depositInvoiceNumber ?? "");
      expect((voidedNote!.meta as { invoice_id?: string })?.invoice_id).toBe(depositInvoiceId);

      const statusChange = (acts ?? []).find(
        (a) => a.type === "status_change" && typeof a.summary === "string" && /invoice.*voided/i.test(a.summary),
      );
      expect(statusChange, `expected the mark-lost status_change summary to report the void; got: ${JSON.stringify(acts)}`).toBeTruthy();
    });
  });
});
