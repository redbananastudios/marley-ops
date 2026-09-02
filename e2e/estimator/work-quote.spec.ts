import { test, expect } from "@playwright/test";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { step } from "../fixtures/artefacts";

/**
 * Estimator work+quote flow (closes the spec_gaps.estimator_work_quote_specs
 * gap tracked in qa/state.json): create a lead → book a survey for a PAST slot
 * today → open Create Quote from the lead's Quotes tab → land straight on
 * /quotes/{id} with a real draft row already created (the /quotes/new?leadId=
 * page renders read-only and CreateDraftAndOpen makes the draft with one
 * client-side createDraftQuote call, QA-20260828-02; there is no separate
 * confirm step — landing on /quotes/{id} IS the creation).
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

/**
 * Delete everything one of these blocks created, children before parents, per
 * the FK graph (supabase/migrations/0001_init.sql, amended by 0092):
 *
 *   communications.lead_id → leads    (NO ACTION; quote_id is SET NULL since 0092)
 *   appointments.survey_id → surveys  (NO ACTION — appointments BEFORE surveys)
 *   appointments.lead_id   → leads    (NO ACTION)
 *   surveys.lead_id        → leads    (NO ACTION — the FK that used to block the
 *                                      lead delete and silently leak the whole set)
 *   quotes.lead_id         → leads    (NO ACTION)
 *   activities.lead_id     → leads    (NO ACTION)
 *   leads.client_id        → clients  (NO ACTION — lead BEFORE client)
 *
 * survey_photos, appointment_assignments, follow_ups and lead_briefs CASCADE
 * from those parents; signatures/job_notes/job_media are SET NULL — none need
 * a hand-rolled delete here.
 *
 * House discipline (#71): every delete's error is captured, the parent is read
 * back to PROVE deletion, and any problem THROWS — a teardown that fails
 * quietly leaks rows into staging and makes every later run look broken.
 */
async function teardownLeadGraph(marker: string, knownLeadId?: string): Promise<void> {
  const sb = adminClient();
  const problems: string[] = [];
  const check = (label: string, error: { message: string } | null) => {
    if (error) problems.push(`${label}: ${error.message}`);
  };

  // Resolve by marker, not only the captured id: the lead's name IS the marker
  // (the form asserts the fill stuck before submitting), so a run that died
  // after creating the lead but before capturing its URL still gets swept.
  const { data: markerLeads, error: findErr } = await sb
    .from("leads")
    .select("id, client_id")
    .eq("name", marker);
  if (findErr) throw new Error(`teardown could not list marker leads: ${findErr.message}`);
  const leads = [...(markerLeads ?? [])];
  if (knownLeadId && !leads.some((l) => l.id === knownLeadId)) {
    const { data: extra, error: extraErr } = await sb
      .from("leads")
      .select("id, client_id")
      .eq("id", knownLeadId)
      .maybeSingle();
    if (extraErr) problems.push(`leads lookup (${knownLeadId}): ${extraErr.message}`);
    if (extra) leads.push(extra);
  }
  if (!leads.length && !problems.length) return; // nothing was created

  const leadIds = leads.map((l) => l.id);
  if (leadIds.length) {
    // Children first — the order is the FK graph above, leaf-most upward.
    check("communications", (await sb.from("communications").delete().in("lead_id", leadIds)).error);
    check("appointments", (await sb.from("appointments").delete().in("lead_id", leadIds)).error);
    check("surveys", (await sb.from("surveys").delete().in("lead_id", leadIds)).error);
    check("quotes", (await sb.from("quotes").delete().in("lead_id", leadIds)).error);
    check("activities", (await sb.from("activities").delete().in("lead_id", leadIds)).error);
    check("leads", (await sb.from("leads").delete().in("id", leadIds)).error);
  }

  // The client is a dedupe target (one live row per phone/email), so an earlier
  // run's leak — or a real staging record — can share it. Delete only when no
  // other lead still references it; a shared parent left in place is correct,
  // not a teardown failure.
  for (const clientId of [...new Set(leads.map((l) => l.client_id).filter(Boolean))]) {
    const { count: leadsLeft, error: leftErr } = await sb
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("client_id", clientId);
    if (leftErr) {
      problems.push(`clients (${clientId}) still-referenced check: ${leftErr.message}`);
      continue;
    }
    if (leadsLeft) continue;
    check("clients", (await sb.from("clients").delete().eq("id", clientId)).error);
  }

  // Read the parent back — deletion is proven, never assumed.
  const { count, error: backErr } = await sb
    .from("leads")
    .select("*", { count: "exact", head: true })
    .eq("name", marker);
  if (backErr) problems.push(`lead read-back: ${backErr.message}`);
  else if (count) problems.push(`leads: ${count} marker row(s) still present after delete`);

  if (problems.length) {
    throw new Error(`work-quote teardown left rows behind (${marker}): ${problems.join("; ")}`);
  }
}

test.describe.serial("Estimator — book survey (past slot) then Create Quote from the visit", () => {
  const marker = `E2E Estimator Work Quote ${Date.now()}`;
  let leadUrl = "";

  // A spec that creates staging rows through the UI must not run where it
  // cannot clean them up (same rule the visit-dialog block below applies).
  test.skip(
    !E2E_DB_READY,
    "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY so the afterAll teardown can remove the lead/survey/quote set this block creates through the UI.",
  );

  test.afterAll(async () => {
    // The skip above guarantees nothing ran (so nothing was created) without
    // the DB env — this early return is not a silent teardown failure.
    if (!E2E_DB_READY) return;
    await teardownLeadGraph(marker, leadUrl.match(/\/leads\/([0-9a-f-]{36})/)?.[1]);
  });

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

    await step("New quote lands on /quotes/{id} first time — the draft row already exists", page, async () => {
      // ONE click, no retry loop. The old 3-attempt loop here papered over
      // QA-20260828-02: /quotes/new?leadId= wrote the draft during a render
      // Next can fire twice per soft navigation, so the first transition
      // intermittently crashed to the error boundary. The page render is
      // read-only now — success on the first attempt is the assertion.
      await page.getByRole("link", { name: "New quote", exact: true }).click();
      await page.waitForURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15000 });
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

  test.skip(!process.env.E2E_ESTIMATOR_PASSWORD, "same credential gap as the block above.");
  test.skip(
    !E2E_DB_READY,
    "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for the quote-count read-back and the afterAll teardown.",
  );

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
      // dispatchEvent, not click({ force: true }). force skips the actionability
      // CHECKS but still clicks a COORDINATE, so when FullCalendar insets
      // overlapping events into a shared harness, the sibling sitting over our
      // centre point receives the click and ITS dialog opens. That is not
      // hypothetical - it is exactly how this spec failed on staging (run
      // 33243645783): the URL matched /quotes/{uuid} because a draft really was
      // created, just against whichever lead the sibling belonged to, leaving
      // zero rows for ours.
      //
      // dispatchEvent fires the event ON the node itself, so no overlapping
      // element can intercept it. FullCalendar's interaction plugin listens by
      // delegation - a 'click' listener on the calendar root that resolves
      // closest('.fc-event') from the target - so a dispatched click bubbles up
      // and runs the real eventClick handler for OUR event.
      await event.first().scrollIntoViewIfNeeded();
      await event.first().dispatchEvent("click");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // Prove WHOSE dialog this is BEFORE doing anything irreversible. Titles
      // are system-generated "Survey - <lead name>" and DialogTitle renders that
      // title, so the marker is in it. An earlier attempt at this assertion was
      // abandoned as "guessing at the DOM"; it was sound, and without it a
      // mis-click was caught only at the END - after it had already created a
      // stray draft quote against a stranger's lead.
      await expect(dialog).toContainText(marker);
      // It is a SURVEY dialog (the one that offers Create Quote), not some
      // other appointment's.
      await expect(dialog.getByRole("button", { name: "Create Quote", exact: true })).toBeVisible();
    });

    await step("click Create Quote (client-side router.push, not a page.goto)", page, async () => {
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Create Quote", exact: true }).click();
      await page.waitForURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15000 });
    });

    await step("no generic error boundary, and exactly one quotes row exists for this lead", page, async () => {
      await expect(page.getByText(/Something went wrong|Application error/i)).toHaveCount(0);

      const sb = adminClient();
      const { data, error } = await sb.from("quotes").select("id").eq("lead_id", leadId);
      if (error) throw new Error(`quotes read-back: ${error.message}`);
      expect(data?.length, "exactly one draft quote row for this lead, no duplicate from the double-render race").toBe(1);
      expect(page.url()).toContain(`/quotes/${data![0].id}`);
    });
  });

  test.afterAll(async () => {
    // The old teardown here never deleted SURVEYS, so surveys.lead_id blocked
    // the lead delete on every run — and because no error was checked, it
    // failed silently and leaked the full lead/survey/quote set into staging
    // each time. teardownLeadGraph deletes in FK order, reads the lead back,
    // and THROWS on any failure.
    if (!E2E_DB_READY) return; // skipped above — nothing ran, nothing to clean
    await teardownLeadGraph(marker, leadId || undefined);
  });
});
