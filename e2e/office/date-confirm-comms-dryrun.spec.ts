import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { openDialog } from "../fixtures/ui";

/**
 * IO proof: the office "Confirm in person" action (the same pipeline the
 * public /q date-confirm card runs — confirmMoveDate in lib/quote/accept-flow.ts)
 * writes BOTH a customer-facing email AND SMS to `communications`. Until this
 * spec, the date-confirmation step had no e2e coverage at all — the survey
 * booked/moved/cancelled notices already send both channels
 * (schedule/actions.ts sendSurveyCustomerNotice), but a removal's own "your
 * date is locked in" moment only ever emailed. This proves the SMS half of
 * that gap is closed, through the real confirmDateInPersonAction server
 * action, not a unit test against the copy builder alone
 * (tests/lib/comms/date-confirm-email.test.ts already covers that).
 *
 * Deliberately seeded so the commitment invoice amount is ZERO (deposit
 * £300 already covers 25% of a £1,000 job): ensureCommitmentInvoice's own
 * `if (amount <= 0) return quote` short-circuits before any Zoho call, so
 * this proves the SMS/email wiring without spending any of the shared
 * staging org's daily API quota (see qa/state.json io.zoho_daily_quota and
 * O:\RBS-OS\references\zoho-api.md — CI has already exhausted this quota
 * once from cumulative e2e runs). The zero-commitment branch is also the
 * one dateConfirmationSms's "nothing to pay right now" copy covers.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (CI exports
 * both) to seed/tear down its marker fixture — set in CI, usually unset
 * locally.
 */
test.skip(
  !E2E_DB_READY,
  "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed the marker fixture",
);

const MARKER = `E2E-DATECONFIRM-COMMS-${Date.now()}`;
const DEPOSIT = 300; // covers the 25% commitment on a £1,000 job — zero invoice, zero Zoho calls
const TOTAL = 1000;
const CUSTOMER_EMAIL = "qa-sentinel-dateconfirmcomms-sink@marleymoves.test";
const CUSTOMER_PHONE = "07700900114";

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
      phone: CUSTOMER_PHONE,
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
  // Well beyond T-7 so the late-booking/collapsed-ask rules never engage —
  // this fixture is scoped purely to the confirm-date comms wiring.
  const movingDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const { data: quote, error: qErr } = await sb
    .from("quotes")
    .insert({
      quote_ref: quoteRef,
      client_id: client.id,
      lead_id: lead.id,
      customer_name: `${MARKER} Client`,
      customer_email: CUSTOMER_EMAIL,
      customer_phone: CUSTOMER_PHONE,
      subtotal: TOTAL,
      grand_total: TOTAL,
      agreed_price: TOTAL,
      status: "accepted",
      accepted_at: new Date().toISOString(),
      moving_date: movingDate,
      deposit_amount: DEPOSIT,
      deposit_paid_at: new Date().toISOString(),
      deposit_paid_method: "bank_transfer",
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
    check("events_log", (await sb.from("events_log").delete().eq("entity_type", "lead").eq("entity_id", fx.leadId)).error);
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

test.describe.serial("IO proof — 'Confirm in person' writes BOTH a date-confirmation email and SMS", () => {
  test.beforeAll(async () => {
    fx = await seed();
  });

  test.afterAll(async () => {
    if (fx) await teardown(fx);
  });

  test("office confirms the move date in person via the real /leads/[id] dialog", async ({ page }) => {
    await step("open the lead and confirm the date is not yet confirmed", page, async () => {
      await page.goto(`/leads/${fx!.leadId}`);
      await expect(page.getByText("Move date confirmation")).toBeVisible();
      await expect(page.getByText("Date not confirmed", { exact: false })).toBeVisible();
    });

    await step("tick the acknowledgment, type the customer's name, confirm", page, async () => {
      const dialog = await openDialog(page, page.getByRole("button", { name: "Confirm in person" }));
      await dialog.getByRole("checkbox").check();
      await dialog.getByLabel("Customer's full name").fill(`${MARKER} Client`);
      await dialog.getByRole("button", { name: "Confirm date" }).click();
      await expect(page.getByText(/the customer has the confirmation email/i)).toBeVisible();
    });

    await step("leads.date_confirmed_at is stamped", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("leads")
        .select("date_confirmed_at")
        .eq("id", fx!.leadId)
        .single();
      expect(error).toBeNull();
      expect(data?.date_confirmed_at).toBeTruthy();
    });

    await step("a genuine customer-facing dry-run EMAIL exists", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("communications")
        .select("channel, to_address, subject, status, provider_id, direction")
        .ilike("subject", `%${fx!.quoteRef}%`)
        .eq("channel", "email");
      expect(error).toBeNull();
      expect(data?.length).toBeGreaterThan(0);
      const row = data![0];
      expect(row.to_address).toBe(CUSTOMER_EMAIL);
      expect(row.direction).toBe("outbound");
      expect(row.status).toBe("sent");
      expect(row.provider_id).toMatch(/^dryrun-email-/);
    });

    await step("a genuine customer-facing dry-run SMS also exists, distinct from the email", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("communications")
        .select("channel, to_address, body, status, provider_id, direction, lead_id, quote_id")
        .eq("lead_id", fx!.leadId)
        .eq("channel", "sms");
      expect(error).toBeNull();
      // A dateConfirmationSms crash, a missing customer_phone read, or dispatchComm
      // throwing on the sms channel would all show up as ZERO rows here —
      // sendDateConfirmationEmail's SMS block is fail-soft and logs rather than
      // throws, so this is the one place that failure is visible.
      expect(data?.length).toBeGreaterThan(0);
      const row = data![0];
      expect(row.to_address).toBe(CUSTOMER_PHONE);
      expect(row.direction).toBe("outbound");
      expect(row.status).toBe("sent");
      expect(row.provider_id).toMatch(/^dryrun-sms-/);
      expect(row.quote_id).toBe(fx!.quoteId);
      // The zero-commitment branch this fixture exercises: no link, no
      // "penalty", names the phone rather than an amount due.
      expect(row.body).toContain("Nothing to pay right now");
      expect(row.body).not.toContain("http");
      expect(row.body?.toLowerCase()).not.toContain("penalty");
    });

    await step("no commitment invoice was raised — the deposit already covered it, zero Zoho calls", page, async () => {
      const sb = adminClient();
      const { data, error } = await sb
        .from("quotes")
        .select("zoho_commitment_invoice_id, commitment_invoice_amount")
        .eq("id", fx!.quoteId)
        .single();
      expect(error).toBeNull();
      expect(data?.zoho_commitment_invoice_id).toBeNull();
    });
  });
});
