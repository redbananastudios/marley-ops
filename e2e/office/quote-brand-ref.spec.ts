import { test, expect } from "@playwright/test";
import { E2E_DB_READY, adminClient } from "../fixtures/db";

/**
 * Multi-brand gates 1-5 (PRD): a quote for a Pitmans-brand lead should mint a
 * PM-prefixed ref (PMR###/PMC###), matching Marley's own MM-prefixed refs one
 * counter over. `next_quote_ref` already supports this (migration
 * 0104_brands.sql, `brand text default 'marley'`), but `nextQuoteRef()` in
 * `app/(dashboard)/quotes/actions.ts` never passes the lead's resolved brand
 * into the RPC call, so every quote — regardless of `quotes.brand` — mints an
 * MM-prefixed ref. Filed as QA-20260825-03 (risky: bank-reconciliation +
 * quote-ref-immutability implications once a naive fix is attempted, since an
 * already-issued MM-prefixed Pitmans ref must never be silently reissued).
 *
 * SKIPPED until the repair PR passes `brand` into `sb.rpc("next_quote_ref", ...)`
 * — un-skip by deleting the KNOWN_BUG guard below once QA-20260825-03 closes.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the CI e2e job
 * exports both) to seed and tear down its own marker fixture — this env
 * usually doesn't have them locally.
 */
test.skip(!E2E_DB_READY, "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker pitmans lead");

const KNOWN_BUG_QA_20260825_03 = true;
test.skip(
  KNOWN_BUG_QA_20260825_03,
  "QA-20260825-03: quotes for a pitmans-brand lead mint an MM-prefixed ref instead of PM — un-skip once the repair PR lands",
);

const MARKER = "E2E-QUOTE-BRAND-REF";

interface Fixture {
  clientId: string;
  leadId: string;
}

async function seed(): Promise<Fixture> {
  const sb = adminClient();

  const { data: client, error: cErr } = await sb
    .from("clients")
    .insert({ display_name: `${MARKER} Client`, notes: MARKER })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed client: ${cErr.message}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      brand: "pitmans",
      status: "quoted",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} Lead`,
      phone: "07700900000",
      email: "e2e-quote-brand-ref@marleymoves.test",
      from_postcode: "DT11 7AA",
      to_postcode: "SP7 8AA",
      property_size: "2 bedroom",
      media_consent: "unset",
      notes: MARKER,
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed lead: ${lErr.message}`);

  return { clientId: client.id, leadId: lead.id };
}

async function teardown(fx: Fixture | null) {
  if (!fx) return;
  const sb = adminClient();
  await sb.from("activities").delete().eq("lead_id", fx.leadId);
  await sb.from("quotes").delete().eq("lead_id", fx.leadId);
  await sb.from("leads").delete().eq("id", fx.leadId);
  await sb.from("clients").delete().eq("id", fx.clientId);
}

test.describe("Office — quote ref mints the lead's own brand prefix", () => {
  let fx: Fixture | null = null;

  test.afterEach(async () => {
    await teardown(fx);
    fx = null;
  });

  test("a pitmans-brand lead's new quote gets a PM-prefixed ref, not MM", async ({ page }) => {
    fx = await seed();

    await page.goto(`/quotes/new?leadId=${fx.leadId}`);
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/);
    const quoteId = page.url().match(/\/quotes\/([0-9a-f-]{36})/)?.[1];
    if (!quoteId) throw new Error("did not land on a draft quote page");

    const sb = adminClient();
    const { data: quote, error } = await sb
      .from("quotes")
      .select("brand, quote_ref")
      .eq("id", quoteId)
      .single();
    if (error) throw new Error(`read back quote: ${error.message}`);

    expect(quote.brand).toBe("pitmans");
    expect(quote.quote_ref).toMatch(/^PM[RC]\d+$/);
  });
});
