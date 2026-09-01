import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { step } from "../fixtures/artefacts";

/**
 * Commercial-money ladder (PRD §3.10, gates 16/17/20 — merged 2026-08-31/09-01)
 * live-verified on two admin surfaces that had never had permanent coverage:
 *
 * 1. `components/leads/payments-card.tsx` — a commercial-policy accepted lead's
 *    deposit cell must read "None — business terms take no deposit." instead of
 *    falling through to the editable £-input every prior policy used, which
 *    would invite the office to start a deposit chase the policy says never
 *    runs (a commercial job takes ONE invoice on completion, never a deposit).
 * 2. `app/(dashboard)/payments/upcoming-tab.tsx`'s "Commercial, not yet dated"
 *    card — a commercial booking whose completion invoice hasn't been raised
 *    yet must still show as real, unplaced money (not silently omitted, which
 *    would read as "nothing expected" about a live unpaid job).
 *
 * Proven live against staging 2026-09-01 (QA audit) by a throwaway QA-SENTINEL
 * admin login (service-role minted, not the persistent E2E fixture): both
 * locators below matched exactly once against the deployed page for a fresh
 * marker fixture, cross-checked against SQL truth by the audit's admin
 * role-agent (0 findings — see qa/state.json admin.mark_deposit_balance_paid
 * and truth.payments_tabs_totals).
 *
 * Ships SKIPPED: this environment has no persistent E2E_OFFICE_PASSWORD (the
 * `.auth/office.json` storageState fixture `auth.setup.ts` needs), matching
 * the existing pattern for admin specs in this repo (see
 * e2e/office/crew-assignment-to-myjobs.spec.ts). Un-skip once it's set —
 * expected to actually pass, not blocked by any known bug: both assertions
 * were separately confirmed against the live DOM via a manual throwaway
 * Playwright login during this same audit run.
 */
test.skip(
  !process.env.E2E_OFFICE_PASSWORD,
  "needs E2E_OFFICE_PASSWORD to sign in the office fixture — set in CI, usually unset locally",
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const dbReady = !!url && !!serviceKey;

function db() {
  if (!dbReady) throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  if (url.includes("supabase.redbananastudios.com")) {
    throw new Error(`E2E refuses to touch the PRODUCTION Supabase host (${url}).`);
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

const MARKER = "QA-SENTINEL commercial-ladder spec";

interface Fixture {
  clientId: string;
  leadId: string;
  quoteId: string;
  quoteRef: string;
}

async function seed(): Promise<Fixture> {
  const sb = db();
  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client`, postcode_home: "SP7 8AA", notes: MARKER, is_company: true })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed client: ${cErr.message}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      status: "confirmed",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} Client`,
      phone: "07700900999",
      email: "qa-sentinel-commercial-ladder@marleymoves.test",
      from_address: "1 Test Street, Shaftesbury",
      from_postcode: "SP7 8AA",
      to_address: "2 Sample Road, Gillingham",
      to_postcode: "SP8 4AB",
      property_size: "3 bedroom",
      notes: MARKER,
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed lead: ${lErr.message}`);

  const quoteRef = `QASENT-CML-${Date.now()}`;
  const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  // Completed job, no completion invoice raised yet: payment_policy=commercial,
  // deposit_amount=0 (commercial never takes one), no commercial_due_date and
  // no zoho_balance_invoice_id — the "awaiting completion" branch of the
  // Upcoming tab's commercialUndated bucket (lib/payments/upcoming.ts).
  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: quoteRef,
      client_id: client.id,
      lead_id: lead.id,
      customer_name: `${MARKER} Client`,
      customer_email: "qa-sentinel-commercial-ladder@marleymoves.test",
      customer_phone: "07700900999",
      subtotal: 3000,
      grand_total: 3000,
      status: "accepted",
      moving_date: at(-2).slice(0, 10),
      payment_policy: "commercial",
      deposit_amount: 0,
      accepted_at: at(-1),
      agreed_price: 3000,
      breakdown: { vehicle: "1luton", totalMiles: 20 },
      state_blob: { seeded: MARKER },
    })
    .select("id")
    .single();
  if (qErr) throw new Error(`seed quote: ${qErr.message}`);

  return { clientId: client.id, leadId: lead.id, quoteId: quote.id, quoteRef };
}

async function teardown(fx: Fixture | null) {
  if (!fx) return;
  const sb = db();
  const problems: string[] = [];
  const check = (table: string, error: { message: string } | null) => {
    if (error) problems.push(`${table}: ${error.message}`);
  };

  check("activities", (await sb.from("activities").delete().eq("lead_id", fx.leadId)).error);
  check("communications", (await sb.from("communications").delete().eq("lead_id", fx.leadId)).error);
  check("quotes", (await sb.from("quotes").delete().eq("id", fx.quoteId)).error);
  check("leads", (await sb.from("leads").delete().eq("id", fx.leadId)).error);
  check("clients", (await sb.from("clients").delete().eq("id", fx.clientId)).error);

  const { count } = await sb.from("quotes").select("*", { count: "exact", head: true }).eq("id", fx.quoteId);
  if (count) problems.push(`quotes: ${count} row(s) still present after delete`);

  if (problems.length) throw new Error(`teardown left rows behind: ${problems.join("; ")}`);
}

test.describe("Office — commercial payments ladder (no deposit, undated completion invoice)", () => {
  let fx: Fixture | null = null;

  test.afterEach(async () => {
    await teardown(fx);
    fx = null;
  });

  test("Payments card takes no deposit on a commercial lead", async ({ page }) => {
    fx = await seed();

    await step("open the marker lead", page, async () => {
      await page.goto(`/leads/${fx!.leadId}`);
    });

    await step("deposit cell reads the commercial sentence, not an editable amount", page, async () => {
      await expect(
        page.getByText("None — business terms take no deposit.", { exact: true }),
      ).toBeVisible();
    });
  });

  test("Upcoming tab lists the undated commercial invoice as real, unplaced money", async ({ page }) => {
    fx = await seed();

    await step("open Payments, Upcoming tab", page, async () => {
      await page.goto("/payments?tab=upcoming");
    });

    await step("the commercial section lists our marker row with its amount", page, async () => {
      await expect(page.getByRole("heading", { name: "Commercial, not yet dated" })).toBeVisible();
      // The quoteRef+reason line — `<p>{quoteRef} · {reason}</p>` — is unique
      // (quoteRef embeds Date.now()). Its amount lives on a SIBLING <span> two
      // levels up (the row's own wrapper div), not inside the <p> itself.
      const line = page.locator("p", { hasText: fx!.quoteRef });
      await expect(line).toContainText("awaiting completion");
      const row = line.locator("xpath=../..");
      await expect(row).toContainText("£3,000.00");
    });
  });
});
