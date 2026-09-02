import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { submitUntil } from "../fixtures/ui";

/**
 * Handoff h3 (QA audit ledger, qa/state.json handoffs): a customer accepts a
 * sent quote on the public /q/<token> page → the office sees the resulting
 * booking + deposit-pending payment state on /bookings and /payments. Never
 * had a permanent spec — public/customer.spec.ts proves the customer side in
 * isolation (Zoho-gated), office/bookings.spec.ts and payments-finance.spec.ts
 * prove the office pages render, but nothing proves the two are the SAME
 * booking: that an accept a customer performs on one page is the row the
 * office sees on the other, moments later, with the right money attached.
 *
 * Self-seeds its own marker client/lead/quote (21 days out, comfortably
 * outside the ≤7-day late-booking collapse window, so the accept leg takes
 * the ordinary £100-deposit path) and tears it down. The customer step uses a
 * FRESH unauthenticated browser context (no storageState) — the office
 * project's own `page` fixture is already signed in as office, which would
 * defeat the point of proving an anonymous customer can do this.
 *
 * Proven live against staging 2026-08-29 by the QA audit's admin role-agent
 * (throwaway marker fixture, real bank-transfer accept, /bookings + /payments
 * both read back the exact agreed price and deposit-pending state) before
 * this spec was written from that recipe.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down its marker fixture — set in CI, usually unset locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker fixture",
);

const MARKER = `E2E-H3-HANDOFF-${Date.now()}`;
const ACCEPT_TOKEN = `${MARKER}-token`.toLowerCase();
const TOTAL = 1400;

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

  // The ref is the marker UNPREFIXED, and that is load-bearing. This accept is
  // a real one: it raises a real staging ledger invoice under
  // depositReference(quote_ref) = "<ref>-DEP". globalTeardown's only ledger
  // cleanup is purgeStagingInvoices("E2E-"), which matches on startsWith — so
  // a "QA-"-prefixed ref (as this was until 2026-09-02) escapes the purge and
  // leaves one invoice in the shared staging org on EVERY CI run. That
  // accretion is not cosmetic: stagingInvoicesByRefPrefix reads a single
  // unpaginated page, so once the org outgrows it the money specs' NEGATIVE
  // assertions ("no balance invoice exists at acceptance") start passing
  // because the lookup truncated, not because nothing was raised.
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
      subtotal: TOTAL,
      grand_total: TOTAL,
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
  // acceptQuoteOnline keeps writing child rows (activities, signatures,
  // follow_ups) AFTER the status flip, so a teardown that starts while the
  // action is still in flight can have children reappear between deletes and
  // trip the leads/clients FKs, stranding the whole marker set
  // (QA-20260902-01 left five behind exactly this way). Two attempts: the
  // first is allowed to lose that race, the second is authoritative.
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    problems = [];
    const check = (label: string, error: { message: string } | null) => {
      if (error) problems.push(`${label}: ${error.message}`);
    };
    check("signatures", (await sb.from("signatures").delete().eq("quote_id", fx.quoteId)).error);
    check("activities", (await sb.from("activities").delete().eq("lead_id", fx.leadId)).error);
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

test.describe.serial("Handoff — customer accepts /q → office sees it on /bookings + /payments", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  test.afterAll(async () => {
    if (fx) await teardown(fx);
  });

  test("customer: accepts the quote via bank transfer (anonymous, no login)", async ({ browser }) => {
    // A FRESH context with no storageState — the office project's own `page`
    // fixture is already signed in, which would defeat the point of proving
    // an anonymous customer can do this.
    const customerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const customerPage = await customerContext.newPage();
    try {
      await step("open the accept link and confirm the quote renders", customerPage, async () => {
        await customerPage.goto(`/q/${ACCEPT_TOKEN}`);
        await expect(customerPage.getByText("Your removal quote")).toBeVisible();
        await expect(customerPage.getByRole("button", { name: /Accept quote & pay/i })).toBeVisible();
      });

      await step("tick the acknowledgments, sign by name, accept", customerPage, async () => {
        await customerPage.waitForLoadState("networkidle");
        // submitUntil survives the pre-hydration native form submit (re-ticks +
        // re-fills on a miss). The landed sentinel must be POST-accept-only
        // copy: since #181 the card-off SENT page already says "pay by bank
        // transfer on the next screen", so /Pay by bank transfer/i matches
        // BEFORE the accept completes and the DB read below races the action
        // (QA-20260902-01). "deposit to secure your date" renders only on the
        // accepted pay screen.
        await submitUntil(customerPage, {
          prepare: async () => {
            const boxes = customerPage.getByRole("checkbox");
            const n = await boxes.count();
            for (let i = 0; i < n; i++) await boxes.nth(i).check();
            await customerPage.getByLabel("Your full name").fill("QA Sentinel Handoff Customer");
          },
          click: customerPage.getByRole("button", { name: /Accept quote & pay/i }),
          expected: customerPage.getByText(/deposit to secure your date/i),
        });
        // Belt and braces: the accept form is gone and the BACS panel is up —
        // this is the pay screen, not the SENT page's card-off sentence.
        await expect(customerPage.getByRole("button", { name: /Accept quote & pay/i })).toHaveCount(0);
        await expect(customerPage.getByText(/Pay by bank transfer/i)).toBeVisible();
      });

      await step("the DB shows the accept with the right money attached", customerPage, async () => {
        const sb = adminClient();
        const { data, error } = await sb
          .from("quotes")
          .select("status, accepted_at, agreed_price, deposit_amount, deposit_paid_at")
          .eq("id", fx!.quoteId)
          .single();
        expect(error).toBeNull();
        expect(data?.status).toBe("accepted");
        expect(data?.accepted_at).toBeTruthy();
        expect(data?.agreed_price).toBe(TOTAL);
        expect(data?.deposit_amount).toBe(100);
        expect(data?.deposit_paid_at).toBeNull(); // bank transfer — not paid yet
      });
    } finally {
      await customerContext.close();
    }
  });

  test("office: /bookings and /payments show the deposit-pending booking", async ({ page }) => {
    await step("/bookings lists the new deposit-outstanding booking", page, async () => {
      await page.goto("/bookings");
      await expect(page.getByRole("heading", { name: "Bookings", exact: true })).toBeVisible();
      const row = page.locator("div").filter({ hasText: fx!.quoteRef }).last();
      await expect(row).toBeVisible();
      await expect(row).toContainText("£1,400");
    });

    await step("/payments Due tab shows the same deposit-pending row", page, async () => {
      await page.goto("/payments?tab=due");
      await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
      // The row's £ figure (sectionAmount) renders as a sibling span of the
      // customer/detail div, not nested inside it — a plain hasText filter on
      // `div` picks the innermost matching div and misses it. Target the row's
      // own flex-row class instead (due-tab.tsx's per-row container).
      const row = page.locator("div.flex.flex-wrap.items-center.gap-x-4.gap-y-2").filter({ hasText: fx!.quoteRef });
      await expect(row).toBeVisible();
      await expect(row).toContainText("£100");
    });
  });
});
