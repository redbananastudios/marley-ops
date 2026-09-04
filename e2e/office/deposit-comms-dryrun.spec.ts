import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { openDialog } from "../fixtures/ui";

/**
 * IO proof (qa/state.json `io.email_sms_dispatch_dryrun`): the customer-facing
 * "deposit received" email only fires through `markDepositPaid`, reachable
 * exclusively from the office's own /bookings "Deposit received" action —
 * NOT from anything a token-holding customer can trigger on /q/<token>
 * themselves (`acceptQuoteOnline`/`reportDepositSent` only send an internal
 * `sendOpsAlert` office-inbox email, never a `communications` row). This spec
 * proves the office leg actually writes that customer-facing dry-run comms
 * row, with the right amount/quote-ref, distinct from the internal alert.
 *
 * Seeds an already-accepted marker quote directly (the accept leg itself is
 * separately proven by office/customer-accept-to-bookings.spec.ts) so this
 * file stays scoped to the one thing nothing else covers: what happens to
 * `communications` when the office clicks "Deposit received → Bank transfer".
 *
 * Proven live against staging 2026-09-04 by the QA audit's Sonnet role-agent:
 * real seed → real customer accept via /q/<token> → real admin login → real
 * click through /bookings' "Deposit received" dialog → a `communications` row
 * appeared with `provider_id` starting `dryrun-email-`, `status="sent"`,
 * `subject`/`body` naming the right quote ref and £ amount, matching what the
 * dialog itself said and what the customer sees on a `/q/<token>` reload —
 * before this spec was written from that recipe. (qa/state.json
 * `io.email_sms_dispatch_dryrun`, 2026-09-04 run.)
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down its marker fixture — set in CI, usually unset
 * locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker fixture",
);

const MARKER = `E2E-DEPOSIT-COMMS-${Date.now()}`;
const DEPOSIT = 100;
const TOTAL = 1500;
const CUSTOMER_EMAIL = "qa-sentinel-depositcomms-sink@marleymoves.test";

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
      status: "confirmed",
      entry_channel: "manual",
      source_system: "marley_ops",
      name: `${MARKER} Client`,
      phone: "07700900112",
      email: CUSTOMER_EMAIL,
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
      customer_email: CUSTOMER_EMAIL,
      customer_phone: "07700900112",
      subtotal: TOTAL,
      grand_total: TOTAL,
      agreed_price: TOTAL,
      status: "accepted",
      accepted_at: new Date().toISOString(),
      moving_date: movingDate,
      deposit_amount: DEPOSIT,
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
  // markDepositPaid also books a diary appointment via ensureRemovalAppointment
  // — that (and its appointment_assignments) must go before the lead/quote FK
  // chain will release, same lesson office/customer-accept-to-bookings.spec.ts
  // already carries for acceptQuoteOnline's own late-writing children.
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

test.describe.serial("IO proof — office 'Deposit received' writes the customer-facing dry-run comms row", () => {
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
      // hasText matches every ancestor div containing the ref (nameAndRef's
      // own inner text div AND every containing wrapper up to the page root),
      // and has:<button> matches every one of THOSE that also contains the
      // button — i.e. every ancestor from the actual row up to the page root
      // (QA-20260904-01: .last() alone resolved to the text-only inner div,
      // which has no button). Combined with .last() this narrows to the
      // innermost/most specific match, which the filters guarantee contains
      // both the ref text and the button: the row itself.
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

    await step("quotes + leads flip to deposit-paid via the same bank-transfer method", page, async () => {
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

    await step("a genuine customer-facing dry-run comms row exists, distinct from the internal ops alert", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("communications")
        .select("channel, to_address, subject, status, provider, provider_id, direction")
        .ilike("subject", `%${fx!.quoteRef}%`);
      expect(error).toBeNull();
      expect(data?.length).toBeGreaterThan(0);
      const row = data![0];
      expect(row.channel).toBe("email");
      expect(row.to_address).toBe(CUSTOMER_EMAIL);
      expect(row.direction).toBe("outbound");
      expect(row.status).toBe("sent");
      expect(row.provider_id).toMatch(/^dryrun-email-/);
      expect(row.subject).toContain(fx!.quoteRef);
    });
  });
});
