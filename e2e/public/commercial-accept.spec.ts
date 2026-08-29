import { test, expect } from "@playwright/test";
import { adminClient } from "../fixtures/db";

/**
 * QA-20260828-03: /q/[token] never checks the client's commercial-ness before
 * rendering the residential accept flow. PRD §3.10 says a commercial quote
 * should render for review only, with no accept action — the server-side
 * refusal in lib/quote/accept-flow.ts already blocks the write correctly, but
 * the page still shows a live "Accept & pay £100 deposit" button and copy for
 * a client that owes no deposit at all.
 *
 * Self-seeds its own marker client/lead/quote (no shared SEED fixture — this
 * scenario needs `clients.is_company: true`, which nothing else uses) and
 * tears it down unconditionally, seed included, even though the assertion
 * itself is skipped until the repair PR lands.
 */
test.describe("Customer — /q commercial quote (QA-20260828-03)", () => {
  test("a sent commercial quote renders review-only, no accept action", async ({ page }) => {
    const sb = adminClient();
    const marker = `QA-SENTINEL commercial-accept-spec ${Date.now()}`;
    const acceptToken = `qa-sentinel-commercial-${Date.now()}`;

    const { data: client, error: clientErr } = await sb
      .from("clients")
      .insert({
        display_name: marker,
        is_company: true,
        company_name: marker,
        postcode_home: "SP7 8AA",
        notes: marker,
      })
      .select("id")
      .single();
    if (clientErr || !client) throw new Error(`Seeding commercial client failed: ${clientErr?.message}`);

    const { data: lead, error: leadErr } = await sb
      .from("leads")
      .insert({
        client_id: client.id,
        status: "quoted",
        entry_channel: "manual",
        source_system: "marley_ops",
        name: marker,
        phone: "07700900000",
        email: "e2e@marleymoves.test",
        from_address: "1 Test Street, Shaftesbury",
        from_postcode: "SP7 8AA",
        to_address: "2 Sample Road, Gillingham",
        to_postcode: "SP8 4AB",
        property_size: "3 bedroom",
        notes: marker,
      })
      .select("id")
      .single();
    if (leadErr || !lead) throw new Error(`Seeding commercial lead failed: ${leadErr?.message}`);

    const { data: quote, error: quoteErr } = await sb
      .from("quotes")
      .insert({
        quote_ref: marker,
        client_id: client.id,
        lead_id: lead.id,
        customer_name: marker,
        customer_email: "e2e@marleymoves.test",
        customer_phone: "07700900000",
        subtotal: 4500,
        grand_total: 4500,
        status: "sent",
        // No payment_policy value seeded — it is only ever snapshotted at
        // acceptance (gate 8). Pre-accept, EVERY quote carries payment_policy
        // null; the page must resolve commercial-ness live from the client,
        // the same way lib/quote/accept-flow.ts's snapshotPaymentPolicy does.
        moving_date: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
        deposit_amount: 100,
        accept_token: acceptToken,
        email_sent_at: new Date().toISOString(),
        collect_addr: "1 Test Street, Shaftesbury, SP7 8AA",
        dest_addr: "2 Sample Road, Gillingham, SP8 4AB",
        vat_enabled: true,
        state_blob: { seeded: marker },
      })
      .select("id")
      .single();
    if (quoteErr || !quote) throw new Error(`Seeding commercial quote failed: ${quoteErr?.message}`);

    try {
      // Un-skipped by the repair PR: /q now resolves the policy LIVE (the
      // column is null on every sent quote) and renders a review-only screen.
      await page.goto(`/q/${acceptToken}`);

      // Nothing that asks for money or offers to take it.
      await expect(page.getByRole("button", { name: /Accept quote & pay/i })).not.toBeVisible();
      await expect(page.getByText(/deposit secures the booking/i)).not.toBeVisible();

      // And the positive half — without it this passes just as well against a
      // page that failed to render at all, which is how a "no accept button"
      // assertion quietly becomes worthless.
      await expect(page.getByText(/Nothing to pay now/i)).toBeVisible();
      await expect(page.getByText(/payable on your agreed terms/i)).toBeVisible();
      await expect(page.getByText("£4,500")).toBeVisible();
    } finally {
      await sb.from("quotes").delete().eq("id", quote.id);
      await sb.from("leads").delete().eq("id", lead.id);
      await sb.from("clients").delete().eq("id", client.id);
    }
  });
});
