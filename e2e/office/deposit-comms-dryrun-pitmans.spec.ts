import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { openDialog } from "../fixtures/ui";

/**
 * Pitmans-brand sibling of deposit-comms-dryrun.spec.ts (QA-20260904-01's own
 * fix made this locator reusable). That spec proves the office "Deposit
 * received" action writes a genuine customer-facing dry-run comms row for
 * Marley; this one proves the SAME action doesn't break, and addresses the
 * comm correctly, for a Pitmans-brand quote — through the REAL
 * markDepositPaid → dispatchComm path, not the standalone
 * scripts/create-resend-templates.mjs push (already verified 2026-09-04) and
 * not a unit test against a synthetic brand fixture. Multi-brand PRD §13 gap:
 * no e2e spec previously drove a real Pitmans send through this action.
 *
 * SCOPE, deliberately: `communications.body` persists only `bodyText` (see
 * lib/comms/dispatch.ts) — the plain-text SMS-style summary passed alongside
 * `bodyHtml`, never the rendered HTML itself (dry-run or not). Both the
 * subject and bodyText for this comm are brand-AGNOSTIC by design (same
 * wording for every brand; only the HTML carries the logo/colours/
 * disclosures). So this spec cannot and does not assert HTML branding from
 * the database — that's proven instead by (a) tests/lib/comms/
 * email-brand.test.ts against a synthetic pitmans fixture, and (b) the
 * manual visual check against the live standalone Resend template push
 * (2026-09-04). What THIS spec proves, which neither of those can: brandForComms
 * resolves without error for a real Pitmans row and the resulting comm is
 * correctly scoped (right recipient, right channel, right quote) — a
 * genuine runtime/wiring failure for a non-default brand would surface here
 * and nowhere else.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down its marker fixture — set in CI, usually unset
 * locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker fixture",
);

const MARKER = `E2E-PM-DEPOSIT-COMMS-${Date.now()}`;
const DEPOSIT = 100;
const TOTAL = 1500;
const CUSTOMER_EMAIL = "qa-sentinel-pmdepositcomms-sink@marleymoves.test";

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
    .insert({ display_name: `${MARKER} Client`, notes: MARKER, postcode_home: "DT11 7AA" })
    .select("id")
    .single();
  if (cErr || !client) throw new Error(`seed client: ${cErr?.message ?? "no row returned"}`);

  const { data: lead, error: lErr } = await sb
    .from("leads")
    .insert({
      client_id: client.id,
      brand: "pitmans",
      status: "confirmed",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} Client`,
      phone: "07700900113",
      email: CUSTOMER_EMAIL,
      from_address: "1 Test Street, Blandford",
      from_postcode: "DT11 7AA",
      to_address: "2 Sample Road, Shaftesbury",
      to_postcode: "SP7 8AA",
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
      brand: "pitmans",
      client_id: client.id,
      lead_id: lead.id,
      customer_name: `${MARKER} Client`,
      customer_email: CUSTOMER_EMAIL,
      customer_phone: "07700900113",
      subtotal: TOTAL,
      grand_total: TOTAL,
      agreed_price: TOTAL,
      status: "accepted",
      accepted_at: new Date().toISOString(),
      moving_date: movingDate,
      deposit_amount: DEPOSIT,
      collect_addr: "1 Test Street, Blandford, DT11 7AA",
      dest_addr: "2 Sample Road, Shaftesbury, SP7 8AA",
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
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    problems = [];
    const check = (label: string, error: { message: string } | null) => {
      if (error) problems.push(`${label}: ${error.message}`);
    };
    const { data: appts } = await sb.from("appointments").select("id").eq("lead_id", fx.leadId);
    for (const a of appts ?? []) {
      check("appointment_assignments", (await sb.from("appointment_assignments").delete().eq("appointment_id", a.id)).error);
    }
    check("appointments", (await sb.from("appointments").delete().eq("lead_id", fx.leadId)).error);
    check("communications", (await sb.from("communications").delete().ilike("subject", `%${fx.quoteRef}%`)).error);
    check("activities", (await sb.from("activities").delete().eq("lead_id", fx.leadId)).error);
    check("follow_ups", (await sb.from("follow_ups").delete().eq("lead_id", fx.leadId)).error);
    check("signatures", (await sb.from("signatures").delete().eq("quote_id", fx.quoteId)).error);
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

test.describe.serial("IO proof — a Pitmans-brand 'Deposit received' writes a Pitmans-branded dry-run comms row", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  test.afterAll(async () => {
    if (fx) await teardown(fx);
  });

  test("office marks the deposit received (bank transfer) via the real /bookings dialog", async ({ page }) => {
    await step("find the marker row and open its Deposit received dialog", page, async () => {
      await page.goto("/bookings");
      await expect(page.getByRole("heading", { name: "Bookings", exact: true })).toBeVisible();
      const row = page
        .locator("div")
        .filter({ hasText: fx!.quoteRef })
        .filter({ has: page.getByRole("button", { name: /Deposit received/i }) })
        .last();
      await expect(row).toBeVisible();
      const dialog = await openDialog(page, row.getByRole("button", { name: /Deposit received/i }));
      await expect(dialog).toContainText(fx!.quoteRef);
      await expect(dialog).toContainText(`£${DEPOSIT}`);
      await dialog.getByRole("button", { name: /Bank transfer/i }).click();
      await expect(page.getByText(/marked paid/i)).toBeVisible();
    });

    await step("quotes flip to deposit-paid via bank transfer", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("quotes")
        .select("deposit_paid_at, deposit_paid_method")
        .eq("id", fx!.quoteId)
        .single();
      expect(error).toBeNull();
      expect(data?.deposit_paid_at).toBeTruthy();
      expect(data?.deposit_paid_method).toBe("bank_transfer");
    });

    await step("markDepositPaid resolved the Pitmans brand without error and wrote a correctly-scoped comm", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("communications")
        .select("channel, to_address, subject, status, provider_id, direction, body")
        .ilike("subject", `%${fx!.quoteRef}%`);
      expect(error).toBeNull();
      // A brandForComms crash, a missing pitmans brands row, or dispatchComm
      // throwing on a non-default brand would all show up as ZERO rows here —
      // markDepositPaid's own error handling logs and continues rather than
      // failing the payment, so this is the one place that failure is visible.
      expect(data?.length).toBeGreaterThan(0);
      const row = data![0];
      expect(row.channel).toBe("email");
      expect(row.to_address).toBe(CUSTOMER_EMAIL);
      expect(row.direction).toBe("outbound");
      expect(row.status).toBe("sent");
      expect(row.provider_id).toMatch(/^dryrun-email-/);
      expect(row.subject).toContain(fx!.quoteRef);
      expect(row.body).toContain(fx!.quoteRef);
      expect(row.body).toContain(`£${DEPOSIT.toFixed(2)}`);
    });
  });
});
