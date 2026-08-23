import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { step } from "../fixtures/artefacts";

/**
 * Handoff h9 (QA audit ledger, qa/state.json): admin assigns a crew member to
 * an appointment via Day Allocation (/schedule?tab=alloc) → the crew member's
 * /my-jobs should show the job, with the correct UK-local date/time. This is
 * the healthy counterpart to h8 (removal-changedate-to-crew.spec.ts, which
 * covers the BUGGY cancel+rebook change-date path) — a completely different
 * code path (plain appointment_assignments insert via setAssignmentsAction,
 * nothing to do with change-date) that h8's finding (QA-20260823-01) had
 * explicitly left untested: "the positive round-trip … was not re-tested".
 *
 * Proven live against staging 2026-08-23 by a throwaway QA-SENTINEL admin +
 * crew login pair (service-role minted, not the persistent E2E fixtures):
 * assigning via the Day Allocation "Assign staff / vehicle" dialog wrote a
 * real appointment_assignments row (confirmed by SQL), the admin board showed
 * the crew chip after reload, and a FRESH browser context signed in as the
 * crew login (identity confirmed via the header name chip) saw the job on
 * /my-jobs under "Tuesday 25 August" reading "09:17–12:17" — exactly the UK
 * local conversion of the seeded starts_at (08:17:41Z) / ends_at (11:17:41Z).
 * 0 findings.
 *
 * Ships SKIPPED: this environment has no persistent E2E_OFFICE_PASSWORD /
 * E2E_CREW_PASSWORD (the `.auth/*.json` storageState fixtures `auth.setup.ts`
 * needs), matching the existing pattern for handoff specs in this repo (see
 * e2e/crew/hours-to-admin-statements.spec.ts). Un-skip once those are set —
 * expected to actually pass, not blocked by any known bug.
 */
test.skip(
  !process.env.E2E_OFFICE_PASSWORD || !process.env.E2E_CREW_PASSWORD,
  "needs E2E_OFFICE_PASSWORD + E2E_CREW_PASSWORD to sign in both fixtures — set in CI, usually unset locally (see qa/state.json handoffs.h9)",
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

const MARKER = "QA-SENTINEL h9 spec";
let leadId: string;
let clientId: string;
let appointmentId: string;
let crewFullName: string;
let startsAt: string;
let endsAt: string;

test.describe.serial("Handoff h9 — admin assigns crew via Day Allocation, crew sees it on /my-jobs", () => {
  test.beforeAll(async () => {
    if (!dbReady) return;
    const sb = db();
    const crewProfileEmail = process.env.E2E_CREW_EMAIL || "e2e-crew@marleymoves.test";
    const { data: crewStaff } = await sb
      .from("staff")
      .select("id, full_name")
      .ilike("email", crewProfileEmail)
      .maybeSingle();
    if (!crewStaff) throw new Error(`no staff row for ${crewProfileEmail} — run scripts/seed-e2e.mjs first`);
    crewFullName = crewStaff.full_name;

    const { data: client, error: cErr } = await sb
      .from("clients")
      .insert({ display_name: `${MARKER} Client`, postcode_home: "SP7 8AA", notes: MARKER })
      .select("id")
      .single();
    if (cErr) throw cErr;
    clientId = client.id;

    const { data: lead, error: lErr } = await sb
      .from("leads")
      .insert({
        client_id: client.id,
        status: "confirmed",
        entry_channel: "manual",
        source_system: "marley_ops",
        name: `${MARKER} Client`,
        phone: "07700900999",
        email: "qa-sentinel-h9@marleymoves.test",
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

    const quoteRef = `QASENT-H9-${Date.now()}`;
    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const { error: qErr } = await sb.from("quotes").insert({
      quote_ref: quoteRef,
      client_id: client.id,
      lead_id: leadId,
      customer_name: `${MARKER} Client`,
      customer_email: "qa-sentinel-h9@marleymoves.test",
      customer_phone: "07700900999",
      subtotal: 1500,
      grand_total: 1500,
      status: "accepted",
      moving_date: at(2).slice(0, 10),
      deposit_amount: 100,
      accepted_at: at(-1),
      agreed_price: 1500,
      breakdown: { vehicle: "1luton", totalMiles: 20 },
      state_blob: { seeded: MARKER },
    });
    if (qErr) throw qErr;

    startsAt = at(2);
    endsAt = new Date(new Date(startsAt).getTime() + 3 * 3_600_000).toISOString();
    // Deliberately NO appointment_assignments row — the assignment below is
    // what's under test.
    const { data: appt, error: aErr } = await sb
      .from("appointments")
      .insert({
        appt_type: "removal",
        client_id: client.id,
        lead_id: leadId,
        title: `${MARKER} Client`,
        starts_at: startsAt,
        ends_at: endsAt,
        status: "scheduled",
        location: "seed",
      })
      .select("id")
      .single();
    if (aErr) throw aErr;
    appointmentId = appt.id;
  });

  test("admin: assign the crew member via Day Allocation", async ({ page }) => {
    const dateStr = new Date(startsAt).toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    await step("open Day Allocation for the marker's date", page, async () => {
      await page.goto(`/schedule?tab=alloc&date=${dateStr}`);
      await page.waitForLoadState("networkidle").catch(() => {});
    });

    // Both the desktop-kanban and tablet-stacked board renders exist in the
    // DOM at once (one hidden by CSS) — pick the VISIBLE copy of the marker
    // card, not just the first match.
    async function visibleMarkerCard() {
      const candidates = page.getByText(`${MARKER} Client`, { exact: true });
      const n = await candidates.count();
      for (let i = 0; i < n; i++) {
        const el = candidates.nth(i);
        if (await el.isVisible()) return el;
      }
      throw new Error("no visible marker card found on the Day Allocation board");
    }

    await step("assign the marker crew member", page, async () => {
      const cardText = await visibleMarkerCard();
      await cardText.scrollIntoViewIfNeeded();
      const card = cardText.locator("xpath=ancestor::div[.//button[contains(., 'Assign staff')]][1]");
      await card.getByRole("button", { name: /assign staff/i }).click();
      await page.getByRole("dialog").getByText(crewFullName, { exact: false }).first().click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByText(/assignments updated/i)).toBeVisible();
    });

    await step("admin board shows the crew chip after reload", page, async () => {
      await page.reload();
      await page.waitForLoadState("networkidle").catch(() => {});
      const chips = page.getByText(crewFullName, { exact: true });
      const n = await chips.count();
      let visible = false;
      for (let i = 0; i < n; i++) {
        if (await chips.nth(i).isVisible()) {
          visible = true;
          break;
        }
      }
      expect(visible, `${crewFullName} chip should be visible on the reloaded board`).toBe(true);
    });
  });

  test("crew: /my-jobs shows the job with the correct UK-local date/time", async ({ browser }) => {
    const crewContext = await browser.newContext({ storageState: "e2e/fixtures/.auth/crew.json" });
    const crewPage = await crewContext.newPage();
    try {
      await step("identity: confirm this really is the marker crew login", crewPage, async () => {
        await crewPage.goto("/my-jobs");
        await expect(crewPage.getByText(crewFullName, { exact: true }).first()).toBeVisible();
      });

      await step("the job appears under the correct UK day", crewPage, async () => {
        const expectedDay = new Date(startsAt).toLocaleDateString("en-GB", {
          timeZone: "Europe/London",
          weekday: "long",
          day: "numeric",
          month: "long",
        });
        const jobCard = crewPage.getByText(`${MARKER} Client`, { exact: true }).first();
        await expect(jobCard).toBeVisible();
        const section = jobCard.locator("xpath=ancestor::section[1]");
        await expect(section.getByRole("heading", { name: expectedDay })).toBeVisible();
      });

      await step("the displayed time matches starts_at/ends_at converted to UK local", crewPage, async () => {
        const ukTime = (iso: string) =>
          new Date(iso).toLocaleTimeString("en-GB", {
            timeZone: "Europe/London",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
        const expectedWindow = `${ukTime(startsAt)}–${ukTime(endsAt)}`;
        await expect(crewPage.getByText(expectedWindow, { exact: false })).toBeVisible();
      });
    } finally {
      await crewContext.close();
    }
  });

  test.afterAll(async () => {
    if (!dbReady || !leadId) return;
    const sb = db();
    if (appointmentId) {
      await sb.from("appointment_assignments").delete().eq("appointment_id", appointmentId);
      await sb.from("appointments").delete().eq("id", appointmentId);
    }
    await sb.from("quotes").delete().eq("lead_id", leadId);
    await sb.from("leads").delete().eq("id", leadId);
    if (clientId) await sb.from("clients").delete().eq("id", clientId);
  });
});
