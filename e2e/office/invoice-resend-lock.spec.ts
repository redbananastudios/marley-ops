import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { openDialog } from "../fixtures/ui";
import { E2E_DB_READY, adminClient } from "../fixtures/db";

/**
 * The legacy iMVE comms lock (lib/legacy.ts) on invoice re-send: it bites on
 * the deposit and commitment rails, which pass their real `commsLocked`
 * value, but the balance rail deliberately passes `commsLocked: false`
 * always (lib/quote/accept-flow.ts resendBalanceInvoiceFlow, "the office
 * raises and emails a final invoice to a legacy customer on purpose" — the
 * lock governs Marley's AUTOMATED correspondence, not operator-initiated
 * collection). A change that armed the balance rail's lock, or disarmed the
 * deposit rail's, would both be silent regressions with no other test
 * covering this file.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the CI e2e job
 * exports both) to seed and tear down its own marker fixtures — this env
 * usually doesn't have them locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker quotes — set in CI, usually unset locally",
);

const MARKER = "E2E-INV-LOCK";

interface Fixture {
  clientId: string;
  leadId: string;
  quoteId: string;
}

const addr = {
  from_address: "1 Test Street, Shaftesbury",
  from_postcode: "SP7 8AA",
  to_address: "2 Sample Road, Gillingham",
  to_postcode: "SP8 4AB",
  property_size: "2 bedroom",
};

async function seedDeposit(): Promise<Fixture> {
  const sb = adminClient();
  const name = `${MARKER} Deposit`;
  const email = "e2e-inv-lock-deposit@marleymoves.test";

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: name, postcode_home: "SP7 8AA", notes: MARKER })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed client: ${cErr.message}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: "quoted",
      entry_channel: "manual",
      source_system: "marley_ops",
      name,
      phone: "07700900001",
      email,
      ...addr,
      notes: `${MARKER} — legacy-locked, deposit raised unpaid`,
      deposit_amount: 100,
      deposit_requested_at: new Date(Date.now() - 24 * 3_600_000).toISOString(),
      deposit_paid_at: null,
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed lead: ${lErr.message}`);

  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: `${MARKER}-DEP-001`,
      client_id: client.id,
      lead_id: lead.id,
      customer_name: name,
      customer_email: email,
      customer_phone: "07700900001",
      subtotal: 1000,
      grand_total: 1000,
      status: "accepted",
      moving_date: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
      deposit_amount: 100,
      deposit_paid_at: null,
      // legacy-locked: imported under the old system, never confirmed by phone.
      source: "imve",
      standard_comms_at: null,
      zoho_deposit_invoice_id: `${MARKER}-ZOHO-DEP`,
      zoho_deposit_invoice_number: `${MARKER}-DEP-INV`,
      breakdown: { vehicle: "1luton", totalMiles: 20 },
      state_blob: { seeded: MARKER },
    })
    .select("id")
    .single();
  if (qErr) throw new Error(`seed quote: ${qErr.message}`);

  return { clientId: client.id, leadId: lead.id, quoteId: quote.id };
}

async function seedBalance(): Promise<Fixture> {
  const sb = adminClient();
  const name = `${MARKER} Balance`;
  const email = "e2e-inv-lock-balance@marleymoves.test";

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: name, postcode_home: "SP7 8AA", notes: MARKER })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed client: ${cErr.message}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: "completed",
      entry_channel: "manual",
      source_system: "marley_ops",
      name,
      phone: "07700900002",
      email,
      ...addr,
      notes: `${MARKER} — legacy booking, final invoice raised unpaid`,
      balance_amount: 1400,
      balance_paid_at: null,
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed lead: ${lErr.message}`);

  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: `${MARKER}-BAL-001`,
      client_id: client.id,
      lead_id: lead.id,
      customer_name: name,
      customer_email: email,
      customer_phone: "07700900002",
      subtotal: 1400,
      grand_total: 1400,
      status: "accepted",
      moving_date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      balance_invoice_amount: 1400,
      // Same legacy shape as the deposit fixture — this rail's lock must stay
      // OFF regardless (see file header).
      source: "imve",
      standard_comms_at: null,
      zoho_balance_invoice_id: `${MARKER}-ZOHO-BAL`,
      zoho_balance_invoice_number: `${MARKER}-BAL-INV`,
      breakdown: { vehicle: "1luton", totalMiles: 20 },
      state_blob: { seeded: MARKER },
    })
    .select("id")
    .single();
  if (qErr) throw new Error(`seed quote: ${qErr.message}`);

  return { clientId: client.id, leadId: lead.id, quoteId: quote.id };
}

async function teardown(fx: Fixture | null) {
  if (!fx) return;
  const sb = adminClient();
  await sb.from("activities").delete().eq("lead_id", fx.leadId);
  await sb.from("communications").delete().eq("lead_id", fx.leadId);
  await sb.from("quotes").delete().eq("id", fx.quoteId);
  await sb.from("leads").delete().eq("id", fx.leadId);
  await sb.from("clients").delete().eq("id", fx.clientId);
}

test.describe("Office — invoice re-send vs the legacy iMVE comms lock", () => {
  let fx: Fixture | null = null;

  test.afterEach(async () => {
    await teardown(fx);
    fx = null;
  });

  test("deposit rail: a legacy-locked booking refuses to send again", async ({ page }) => {
    fx = await seedDeposit();

    await step("the deposit is raised, unpaid, requested — and legacy-locked", page, async () => {
      await page.goto(`/leads/${fx!.leadId}`);
      await expect(page.getByRole("heading", { name: `${MARKER} Deposit` })).toBeVisible();
    });

    const dialog = page.getByRole("dialog");
    await step("opening the resend dialog shows the lock, not a Send button", page, async () => {
      await openDialog(page, page.getByRole("button", { name: "Deposit invoice" }));
    });
    await expect(dialog.getByRole("alert")).toContainText(
      "This is a legacy iMVE booking — turn its standard comms on before emailing them.",
    );
    await expect(dialog.getByRole("button", { name: /^Send/ })).toHaveCount(0);

    await step("nothing was sent", page, async () => {
      const sb = adminClient();
      const { data: comms } = await sb.from("communications").select("id").eq("lead_id", fx!.leadId);
      expect(comms ?? []).toHaveLength(0);
    });
  });

  test("balance rail: the same legacy shape does NOT lock the final invoice", async ({ page }) => {
    fx = await seedBalance();

    await step("the final invoice is raised, unpaid, and awaiting payment", page, async () => {
      await page.goto(`/leads/${fx!.leadId}`);
      await expect(page.getByRole("heading", { name: `${MARKER} Balance` })).toBeVisible();
    });

    const dialog = page.getByRole("dialog");
    await step("opening the resend dialog offers a live Send button, no lock alert", page, async () => {
      await openDialog(page, page.getByRole("button", { name: "Final invoice" }));
    });
    await expect(dialog).toContainText("awaiting payment");
    const sendBtn = dialog.getByRole("button", { name: /^Send again to e2e-inv-lock-balance@marleymoves\.test/ });
    await expect(sendBtn).toBeVisible();

    await step("sending it again succeeds — no comms lock on this rail", page, async () => {
      await dialog.getByRole("button", { name: /^Send again to /i }).click();
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: `${MARKER}-BAL-INV` }),
      ).toBeVisible({ timeout: 30_000 });

      const sb = adminClient();
      const { data: comms, error } = await sb
        .from("communications")
        .select("status, is_override")
        .eq("lead_id", fx!.leadId);
      if (error) throw new Error(`read-back communications: ${error.message}`);
      expect(comms).toHaveLength(1);
      expect(comms![0].status).toBe("sent");
      expect(comms![0].is_override).toBe(true);
    });
  });
});
