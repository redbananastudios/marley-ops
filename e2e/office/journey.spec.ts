import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";

/**
 * Office journey (PRD B2): dashboard, fleet reminders, payment matching, job
 * states. Runs in the "office" project (office storageState). The dashboard +
 * automations legs are assertable now; payment-matching needs the bank-feed /
 * sandbox and is left as a fixme.
 */
test.describe("Office — dashboard + operations", () => {
  test("dashboard and automations load for an office user", async ({ page }) => {
    await step("dashboard renders", page, async () => {
      await page.goto("/");
      await expect(page.getByRole("heading").first()).toBeVisible();
    });

    await step("automations page shows the cron log (incl. crew job sheets)", page, async () => {
      await page.goto("/automations");
      await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
      // Exact match: an open operational-issue alert (e.g. "Crew job sheets has
      // never run") also contains this substring and would otherwise trip
      // Playwright's strict-mode duplicate-match check.
      await expect(page.getByText("Crew job sheets", { exact: true })).toBeVisible();
    });
  });

  test("payment matching + job-state transitions", async () => {
    test.fixme(true, "Needs the bank-feed/sandbox on staging. Assert a surfaced transfer confirms to a deposit and moves the job state, and that job states advance correctly through the board.");
  });
});
