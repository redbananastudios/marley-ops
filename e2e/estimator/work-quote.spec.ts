import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { step } from "../fixtures/artefacts";

/**
 * Estimator work+quote flow (closes the spec_gaps.estimator_work_quote_specs
 * gap tracked in qa/state.json): create a lead → book a survey for a PAST slot
 * today → open Create Quote from the lead's Quotes tab → land straight on
 * /quotes/{id} with a real draft row already created (createDraftQuote runs
 * server-side in app/(dashboard)/quotes/new/page.tsx; there is no separate
 * confirm step — the redirect IS the creation).
 *
 * Self-contained: creates its own throwaway lead by UI rather than depending on
 * a seeded survey/quote existing (mirrors pay-statement.spec.ts's reasoning —
 * "This week" always exists regardless of what else has happened on staging;
 * here, a lead created fresh in this test always has zero surveys/quotes, so
 * "no survey yet" / "no quotes yet" never races other specs' fixtures).
 *
 * Exact recipe verified live against staging 2026-08-22 by a throwaway
 * marker-user run (see qa/state.json estimator.book_survey_quote_from_visit):
 *  - the survey-booking dialog's "Starts" field (#appt-start) defaults to
 *    "now rounded up to the next 15 minutes" — NOT yet attended per
 *    lib/schedule/attended.ts (ends_at must be <= now). Set it explicitly
 *    2 hours in the past so isAttendedSurvey() is true the instant it's booked
 *    and "Create Quote" is available without waiting.
 *  - appointments.estimator_id (and surveys.estimator_id) end up equal to
 *    profiles.id, NOT staff.id — a known gotcha if a future assertion here
 *    ever reaches for the DB row directly.
 *  - booking a survey has real side effects even in dry-run: 1 surveys row,
 *    2 communications rows (booked-notice email+SMS, status=sent,
 *    provider dryrun-*), 4 activities rows (lead_created, survey_booked,
 *    email_sent, sms_sent).
 *
 * BLOCKED FROM RUNNING LOCALLY IN THIS ENVIRONMENT: the "estimator" Playwright
 * project depends on e2e/fixtures/auth.setup.ts, which signs in the PERSISTENT
 * fixture user e2e-estimator@marleymoves.test via E2E_ESTIMATOR_PASSWORD — that
 * env var is not set here (nor E2E_OFFICE_PASSWORD/E2E_CREW_PASSWORD), so the
 * whole project's setup step fails before any spec in this file can run. This
 * is the same credential gap prior audit runs recorded (see qa/state.json).
 * The flow itself was independently proven end-to-end live via a throwaway
 * minted estimator login + service-role SQL read-back — 0 findings, exact
 * match at every step. Skip is a CREDENTIAL gap, not a known app bug — remove
 * the skip once E2E_ESTIMATOR_PASSWORD is available and this should pass as
 * written.
 */
test.skip(
  !process.env.E2E_ESTIMATOR_PASSWORD,
  "E2E_ESTIMATOR_PASSWORD is not set in this environment, so the 'estimator' project's auth.setup.ts cannot sign in e2e-estimator@marleymoves.test and this spec never runs. The underlying flow was proven live via a throwaway minted login + SQL read-back on 2026-08-22 (0 findings) — this is a credential gap, not an app bug. Set E2E_ESTIMATOR_PASSWORD (and re-run `npx playwright test e2e/estimator/work-quote.spec.ts`) to validate this spec for real.",
);

test.describe.serial("Estimator — book survey (past slot) then Create Quote from the visit", () => {
  const marker = `E2E Estimator Work Quote ${Date.now()}`;
  let leadUrl = "";

  test("create a fresh lead via the diary Add lead form", async ({ page }) => {
    await step("open Add lead", page, async () => {
      await page.goto("/leads/new", { waitUntil: "networkidle" });
      // A fresh navigation can outrun hydration; give the form a moment and
      // verify the fill actually stuck before moving on (same pattern as the
      // login retry loop below).
      await page.waitForTimeout(500);
    });

    await step("fill the customer and submit", page, async () => {
      const name = page.getByLabel(/^Name/i).first();
      for (let i = 0; i < 3; i++) {
        await name.fill(marker);
        if ((await name.inputValue()) === marker) break;
        await page.waitForTimeout(400);
      }
      await expect(name).toHaveValue(marker);

      const phone = page.getByLabel(/Phone/i).first();
      if (await phone.count()) await phone.fill("07700900999");

      // Multi-brand staging renders the REQUIRED brand picker (gate 5) — pick
      // the first brand when present (hidden in single-brand mode). Re-picked
      // inside the retry loop below via this locator if a reload clears it.
      const brandPick = page.getByTestId("brand-picker").locator('[data-brand="marley"]');
      if (await brandPick.count()) await brandPick.click();

      let created = false;
      for (let attempt = 1; attempt <= 3 && !created; attempt++) {
        // Re-pick on each attempt in case a pre-hydration reload cleared the
        // selection (clicking an already-selected segment is a no-op).
        if (await brandPick.count()) await brandPick.click();
        await page.getByRole("button", { name: "Add lead", exact: true }).click();
        try {
          await page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 15000 });
          created = true;
        } catch {
          await page.waitForLoadState("networkidle").catch(() => {});
          await page.waitForTimeout(600);
        }
      }
      expect(created, "lead creation should navigate to /leads/{id}").toBe(true);
      leadUrl = page.url();
    });
  });

  test("book a survey for a past slot today — it counts as attended immediately", async ({ page }) => {
    const leadId = leadUrl.match(/\/leads\/([0-9a-f-]{36})/)?.[1];
    expect(leadId, "previous test must have captured a lead id").toBeTruthy();

    await step("open the Book survey dialog for this lead", page, async () => {
      await page.goto(`/schedule/surveys?leadId=${leadId}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Book survey" })).toBeVisible();
    });

    await step("set the slot 2 hours in the past (so it's already attended) and Book", page, async () => {
      const start = page.locator("#appt-start");
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
      await start.fill(past);
      await expect(start).toHaveValue(past);

      const dialog = page.getByRole("dialog");
      let booked = false;
      for (let attempt = 1; attempt <= 3 && !booked; attempt++) {
        await dialog.getByRole("button", { name: "Book", exact: true }).click();
        try {
          await dialog.waitFor({ state: "hidden", timeout: 15000 });
          booked = true;
        } catch {
          await page.waitForTimeout(700);
        }
      }
      expect(booked, "the Book survey dialog should close on submit").toBe(true);
    });
  });

  test("Create Quote from the lead's Quotes tab lands straight on the new draft — no confirm step", async ({ page }) => {
    const leadId = leadUrl.match(/\/leads\/([0-9a-f-]{36})/)?.[1];
    expect(leadId).toBeTruthy();

    await step("open the lead's Quotes tab", page, async () => {
      await page.goto(leadUrl, { waitUntil: "networkidle" });
      await page.getByRole("tab", { name: "Quotes", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Quotes", exact: true })).toBeVisible();
    });

    await step("New quote redirects straight to /quotes/{id} — the draft row already exists", page, async () => {
      let created = false;
      for (let attempt = 1; attempt <= 3 && !created; attempt++) {
        await page.getByRole("link", { name: "New quote", exact: true }).click();
        try {
          await page.waitForURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15000 });
          created = true;
        } catch {
          await page.waitForLoadState("networkidle").catch(() => {});
          await page.waitForTimeout(600);
        }
      }
      expect(created, "New quote should land on /quotes/{id} with the draft already created").toBe(true);
      // No "confirm creation" dialog or intermediate step — the page that loads
      // IS the quote builder for the row createDraftQuote just inserted.
      await expect(page.getByText(/Something went wrong|Application error/i)).toHaveCount(0);
    });
  });
});

/**
 * QA-20260827-03: a SEPARATE entry point to the same page — "Create Quote" in
 * the survey visit's view dialog (components/schedule/appointment-view-dialog.tsx),
 * reached from /schedule/surveys. This is a client-side `router.push`, not the
 * <Link> the "New quote" test above drives — Next rendered
 * app/(dashboard)/quotes/new/page.tsx twice for that navigation and only one of
 * the two redirect() throws survived, so the FIRST visit crashed to the generic
 * error boundary even though the draft quote committed underneath. Fixed by
 * calling createDraftQuote directly from the click handler instead of routing
 * through the page's write-during-render. Needs a lead with NO prior quote —
 * a fresh lead guarantees that, same reasoning as the block above.
 */
test.describe.serial("Estimator — Create Quote from the survey visit dialog (QA-20260827-03)", () => {
  const marker = `E2E Estimator Visit Quote ${Date.now()}`;
  let leadUrl = "";
  let leadId = "";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  test.skip(!process.env.E2E_ESTIMATOR_PASSWORD, "same credential gap as the block above.");
  test.skip(!url || !serviceKey, "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for the quote-count read-back.");

  test("create a fresh lead via the diary Add lead form", async ({ page }) => {
    await step("open Add lead", page, async () => {
      await page.goto("/leads/new", { waitUntil: "networkidle" });
      await page.waitForTimeout(500);
    });

    await step("fill the customer and submit", page, async () => {
      const name = page.getByLabel(/^Name/i).first();
      for (let i = 0; i < 3; i++) {
        await name.fill(marker);
        if ((await name.inputValue()) === marker) break;
        await page.waitForTimeout(400);
      }
      await expect(name).toHaveValue(marker);

      const phone = page.getByLabel(/Phone/i).first();
      if (await phone.count()) await phone.fill("07700900998");

      const brandPick = page.getByTestId("brand-picker").locator('[data-brand="marley"]');
      if (await brandPick.count()) await brandPick.click();

      let created = false;
      for (let attempt = 1; attempt <= 3 && !created; attempt++) {
        if (await brandPick.count()) await brandPick.click();
        await page.getByRole("button", { name: "Add lead", exact: true }).click();
        try {
          await page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 15000 });
          created = true;
        } catch {
          await page.waitForLoadState("networkidle").catch(() => {});
          await page.waitForTimeout(600);
        }
      }
      expect(created, "lead creation should navigate to /leads/{id}").toBe(true);
      leadUrl = page.url();
      leadId = leadUrl.match(/\/leads\/([0-9a-f-]{36})/)?.[1] ?? "";
      expect(leadId).toBeTruthy();
    });
  });

  test("book a survey for a past slot today — it counts as attended immediately", async ({ page }) => {
    await step("open the Book survey dialog for this lead", page, async () => {
      await page.goto(`/schedule/surveys?leadId=${leadId}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Book survey" })).toBeVisible();
    });

    await step("set the slot 2 hours in the past (so it's already attended) and Book", page, async () => {
      const start = page.locator("#appt-start");
      const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
      await start.fill(past);
      await expect(start).toHaveValue(past);

      const dialog = page.getByRole("dialog");
      let booked = false;
      for (let attempt = 1; attempt <= 3 && !booked; attempt++) {
        await dialog.getByRole("button", { name: "Book", exact: true }).click();
        try {
          await dialog.waitFor({ state: "hidden", timeout: 15000 });
          booked = true;
        } catch {
          await page.waitForTimeout(700);
        }
      }
      expect(booked, "the Book survey dialog should close on submit").toBe(true);
    });
  });

  test("Create Quote from the visit's view dialog (router.push) lands on /quotes/{id} with no error boundary", async ({ page }) => {
    await step("open the survey's view dialog from the diary", page, async () => {
      await page.goto("/schedule/surveys", { waitUntil: "networkidle" });
      const event = page.locator(".fc-event").filter({ hasText: marker });
      await expect(event.first()).toBeVisible({ timeout: 15000 });
      await event.first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
    });

    await step("click Create Quote (client-side router.push, not a page.goto)", page, async () => {
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Create Quote", exact: true }).click();
      await page.waitForURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15000 });
    });

    await step("no generic error boundary, and exactly one quotes row exists for this lead", page, async () => {
      await expect(page.getByText(/Something went wrong|Application error/i)).toHaveCount(0);

      const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
      const { data, error } = await sb.from("quotes").select("id").eq("lead_id", leadId);
      if (error) throw new Error(`quotes read-back: ${error.message}`);
      expect(data?.length, "exactly one draft quote row for this lead, no duplicate from the double-render race").toBe(1);
      expect(page.url()).toContain(`/quotes/${data![0].id}`);
    });
  });

  test.afterAll(async () => {
    if (!leadId || !url || !serviceKey) return;
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
    await sb.from("quotes").delete().eq("lead_id", leadId);
    await sb.from("appointments").delete().eq("lead_id", leadId);
    await sb.from("activities").delete().eq("lead_id", leadId);
    await sb.from("communications").delete().eq("lead_id", leadId);
    const { data: lead } = await sb.from("leads").select("client_id").eq("id", leadId).maybeSingle();
    await sb.from("leads").delete().eq("id", leadId);
    if (lead?.client_id) await sb.from("clients").delete().eq("id", lead.client_id);
  });
});
