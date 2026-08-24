import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";

/**
 * The bank-feed "whole quote" link (lib/bank-feed/whole-quote.ts). A customer
 * who settles a job in ONE transfer matches no single ledger item — their
 * money is split across deposit + balance (or + commitment) rows, so it sat
 * in "Transfers that need a human" forever. This offers exactly one extra
 * choice on the Attach/Link dialog: "the whole quote", only when the transfer
 * equals the sum of the quote's already-recorded payments to the penny.
 *
 * Never had a permanent spec — this closes that gap for both the new feature
 * (migration 0103_bank_tx_match_kind_full.sql, match_kind='full') and the
 * pre-existing per-item Attach/Link paths this dialog also drives.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the CI e2e job
 * exports both) to seed and tear down its own marker fixture — this env
 * usually doesn't have them locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker quote/transaction — set in CI, usually unset locally",
);

const MARKER = "E2E-BANK-WHOLE-QUOTE";
const QUOTE_REF = "E2E-BWQ-001";

interface Fixture {
  clientId: string;
  leadId: string;
  quoteId: string;
  txId: string;
}

async function seed(): Promise<Fixture> {
  const sb = adminClient();

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Payer`, postcode_home: "SP7 8AA", notes: MARKER })
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
      name: `${MARKER} Payer`,
      phone: "07700900000",
      email: "e2e-bank-whole-quote@marleymoves.test",
      from_address: "1 Test Street, Shaftesbury",
      from_postcode: "SP7 8AA",
      to_address: "2 Sample Road, Gillingham",
      to_postcode: "SP8 4AB",
      property_size: "2 bedroom",
      notes: `${MARKER} — settled in one transfer`,
      balance_amount: 560,
      balance_paid_at: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed lead: ${lErr.message}`);

  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: QUOTE_REF,
      client_id: client.id,
      lead_id: lead.id,
      customer_name: `${MARKER} Payer`,
      customer_email: "e2e-bank-whole-quote@marleymoves.test",
      customer_phone: "07700900000",
      subtotal: 660,
      grand_total: 660,
      agreed_price: 660,
      status: "accepted",
      moving_date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      deposit_amount: 100,
      deposit_paid_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      breakdown: { vehicle: "1luton", totalMiles: 20 },
      state_blob: { seeded: MARKER },
    })
    .select("id")
    .single();
  if (qErr) throw new Error(`seed quote: ${qErr.message}`);

  // £100 deposit + £560 balance, both already recorded — the transfer that
  // paid them both at once matches neither individually.
  const { data: tx, error: tErr } = await sb
    .from("bank_transactions")
    .insert({
      transaction_id: `${MARKER}-${QUOTE_REF}`,
      tx_date: new Date().toISOString().slice(0, 10),
      amount: 660.0,
      status: "unmatched",
      counterparty: `${MARKER} Payer`,
      description: `${MARKER} full settlement`,
      reference: QUOTE_REF,
    })
    .select("id")
    .single();
  if (tErr) throw new Error(`seed bank_transactions: ${tErr.message}`);

  return { clientId: client.id, leadId: lead.id, quoteId: quote.id, txId: tx.id };
}

async function teardown(fx: Fixture | null) {
  if (!fx) return;
  const sb = adminClient();
  await sb.from("bank_transactions").delete().eq("id", fx.txId);
  await sb.from("activities").delete().eq("lead_id", fx.leadId);
  await sb.from("communications").delete().eq("lead_id", fx.leadId);
  await sb.from("quotes").delete().eq("id", fx.quoteId);
  await sb.from("leads").delete().eq("id", fx.leadId);
  await sb.from("clients").delete().eq("id", fx.clientId);
}

test.describe("Office — bank-feed whole-quote link", () => {
  let fx: Fixture | null = null;

  test.afterEach(async () => {
    await teardown(fx);
    fx = null;
  });

  test("a transfer that pays deposit + balance at once offers a whole-job link", async ({ page }) => {
    fx = await seed();

    const counterpartyText = `${MARKER} Payer`;

    await step("open the unmatched transfer's Attach dialog on /payments", page, async () => {
      await page.goto("/payments");
      const row = page.locator("div.flex.flex-wrap", { hasText: counterpartyText });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Attach" }).click();
    });

    const dialog = page.getByRole("dialog");
    await step("search narrows to the marker quote and offers the whole-job option", page, async () => {
      await expect(dialog).toBeVisible();
      await dialog.getByRole("textbox").fill(QUOTE_REF);
      await expect(dialog.getByText(/Whole job|whole quote/i)).toBeVisible();
      await expect(dialog.getByText("£660.00").first()).toBeVisible();
    });

    await step("linking it reconciles the transfer without re-running the paid pipeline", page, async () => {
      await dialog.getByText(/Whole job|whole quote/i).click();
      await expect(page.locator("[data-sonner-toast]").filter({ hasText: /Linked/i })).toBeVisible();

      const sb = adminClient();
      const { data: tx, error } = await sb
        .from("bank_transactions")
        .select("status, matched_quote_id, match_kind, match_confidence")
        .eq("id", fx!.txId)
        .single();
      if (error) throw new Error(`read-back bank_transactions: ${error.message}`);
      expect(tx.status).toBe("reconciled");
      expect(tx.matched_quote_id).toBe(fx!.quoteId);
      expect(tx.match_kind).toBe("full");

      // The paid pipeline must NOT have re-run — the deposit/balance stamps
      // this fixture seeded stay exactly what they were.
      const { data: quote } = await sb.from("quotes").select("deposit_amount").eq("id", fx!.quoteId).single();
      const { data: lead } = await sb.from("leads").select("balance_amount").eq("id", fx!.leadId).single();
      expect(Number(quote?.deposit_amount)).toBe(100);
      expect(Number(lead?.balance_amount)).toBe(560);
    });
  });
});
