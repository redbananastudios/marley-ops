import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { step } from "../fixtures/artefacts";

/**
 * Handoff h8 (QA audit ledger, qa/state.json): admin changes a booking's move
 * date on /bookings → the previously-assigned crew member's /my-jobs should
 * reflect it. Never had a permanent spec.
 *
 * Proven live against staging 2026-08-23 by a throwaway QA-SENTINEL login pair
 * — and it found a real bug (QA-20260823-01): inside the 7-day window,
 * "Change date" is a cancel+rebook (a NEW appointment row, not an in-place
 * edit), and appointment_assignments is never copied to the new row. The
 * previously-assigned crew member's /my-jobs silently reads "Nothing assigned
 * to you yet" with no cancellation notice of any kind — the office side is
 * told (a "No crew — allocate" chip appears), the crew side is not.
 *
 * FIXED 2026-08-23, direction (b): the assignment still deliberately does not
 * carry over (the office re-allocates on the Job Board — that decision is
 * documented in changeBookingDateAction and was not reversed), but the crew
 * member is now told. Two channels, neither of them a realtime push:
 *   - the night-before job sheet, which re-sends as "Updated job sheet" on any
 *     content change and sends a "you're now clear" sheet to a crew member
 *     whose jobs all went away;
 *   - a "Called off" card on /my-jobs, which is what this spec asserts.
 * Realtime crew-allocation pushes were retired the same day (Peter) so crew
 * have ONE authoritative channel instead of two that can disagree.
 */

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

const MARKER = "QA-SENTINEL h8 spec";
let leadId: string;
let quoteRef: string;
let crewStaffId: string;

test.describe.serial("Handoff h8 — admin change-date rebook vs. crew /my-jobs", () => {
  test.beforeAll(async () => {
    if (!dbReady) return;
    const sb = db();
    const crewProfileEmail = process.env.E2E_CREW_EMAIL || "e2e-crew@marleymoves.test";
    const { data: crewStaff } = await sb.from("staff").select("id").ilike("email", crewProfileEmail).maybeSingle();
    if (!crewStaff) throw new Error(`no staff row for ${crewProfileEmail} — run scripts/seed-e2e.mjs first`);
    crewStaffId = crewStaff.id;
    const { data: vehicle } = await sb.from("vehicles").select("id").eq("is_active", true).limit(1).single();

    const { data: client, error: cErr } = await sb
      .from("clients")
      .insert({ display_name: `${MARKER} Client`, postcode_home: "SP7 8AA", notes: MARKER })
      .select("id")
      .single();
    if (cErr) throw cErr;
    const { data: lead, error: lErr } = await sb
      .from("leads")
      .insert({
        client_id: client.id,
        status: "confirmed",
        entry_channel: "manual",
        source_system: "marley_ops",
        name: `${MARKER} Client`,
        phone: "07700900999",
        email: "qa-sentinel-h8@marleymoves.test",
        from_address: "1 Test Street, Shaftesbury",
        from_postcode: "SP7 8AA",
        to_address: "2 Sample Road, Gillingham",
        to_postcode: "SP8 4AB",
        property_size: "3 bedroom",
        notes: MARKER,
      })
      .select("id")
      .single();
    if (lErr) throw lErr;
    leadId = lead.id;
    quoteRef = `QASENT-H8-${Date.now()}`;
    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const { error: qErr } = await sb.from("quotes").insert({
      quote_ref: quoteRef,
      client_id: client.id,
      lead_id: leadId,
      customer_name: `${MARKER} Client`,
      customer_email: "qa-sentinel-h8@marleymoves.test",
      customer_phone: "07700900999",
      subtotal: 1500,
      grand_total: 1500,
      status: "accepted",
      moving_date: at(1).slice(0, 10),
      deposit_amount: 100,
      accepted_at: at(-1),
      agreed_price: 1500,
      breakdown: { vehicle: "1luton", totalMiles: 20 },
      state_blob: { seeded: MARKER },
    });
    if (qErr) throw qErr;
    const { data: appt, error: aErr } = await sb
      .from("appointments")
      .insert({
        appt_type: "removal",
        client_id: client.id,
        lead_id: leadId,
        title: `${MARKER} Client`,
        starts_at: at(1),
        ends_at: at(1),
        status: "scheduled",
        location: "seed",
      })
      .select("id")
      .single();
    if (aErr) throw aErr;
    const { error: asErr } = await sb.from("appointment_assignments").insert([
      { appointment_id: appt.id, staff_id: crewStaffId },
      ...(vehicle ? [{ appointment_id: appt.id, vehicle_id: vehicle.id }] : []),
    ]);
    if (asErr) throw asErr;
  });

  test("admin: change the move date inside the 7-day window", async ({ page }) => {
    await step("open the marker booking and change its date", page, async () => {
      await page.goto("/bookings");
      await page.getByText(quoteRef).scrollIntoViewIfNeeded();
      const row = page.getByText(quoteRef).locator("xpath=ancestor::div[contains(@class,'px-5')][1]");
      await row.getByRole("button", { name: /change date/i }).click();
      const newStart = new Date(Date.now() + 14 * 86_400_000);
      const newEnd = new Date(newStart.getTime() + 2 * 3_600_000);
      const fmt = (d: Date) => d.toISOString().slice(0, 16);
      await page.locator('input[type="datetime-local"]').first().fill(fmt(newStart));
      await page.locator('input[type="datetime-local"]').nth(1).fill(fmt(newEnd));
      const ack = page.locator('input[type="checkbox"]');
      if (await ack.count()) await ack.check();
      await page.getByRole("button", { name: /release old date.*rebook/i }).click();
      await expect(page.getByText(/original date released/i)).toBeVisible();
    });

    await step("office sees the booking now needs crew allocated", page, async () => {
      await page.reload();
      const row = page.getByText(quoteRef).locator("xpath=ancestor::div[contains(@class,'px-5')][1]");
      await expect(row.getByText(/no crew.*allocate/i)).toBeVisible();
    });
  });

  test("crew: the previously-assigned member should be told, not just dropped", async ({ browser }) => {
    const crewContext = await browser.newContext({ storageState: "e2e/fixtures/.auth/crew.json" });
    const crewPage = await crewContext.newPage();
    try {
      await step("crew /my-jobs shows the job was called off, not just silence", crewPage, async () => {
        await crewPage.goto("/my-jobs");
        // The bug this spec guards (QA-20260823-01): this page used to read
        // "Nothing assigned to you yet" with zero indication the job had gone.
        const calledOff = crewPage.getByTestId("called-off-job");
        await expect(calledOff.first()).toBeVisible();
        await expect(calledOff.filter({ hasText: MARKER }).first()).toBeVisible();
        await expect(crewPage.getByRole("heading", { name: /called off/i })).toBeVisible();
        // And the silence itself must be gone.
        await expect(crewPage.getByText(/nothing assigned to you yet/i)).toHaveCount(0);
      });
    } finally {
      await crewContext.close();
    }
  });

  test.afterAll(async () => {
    if (!dbReady || !leadId) return;
    const sb = db();
    const { data: appts } = await sb.from("appointments").select("id").eq("lead_id", leadId);
    const apptIds = (appts ?? []).map((a) => a.id);
    if (apptIds.length) {
      await sb.from("appointment_assignments").delete().in("appointment_id", apptIds);
      await sb.from("appointments").delete().in("id", apptIds);
    }
    await sb.from("quotes").delete().eq("lead_id", leadId);
    const { data: lead } = await sb.from("leads").select("client_id").eq("id", leadId).single();
    await sb.from("leads").delete().eq("id", leadId);
    if (lead?.client_id) await sb.from("clients").delete().eq("id", lead.client_id);
  });
});
