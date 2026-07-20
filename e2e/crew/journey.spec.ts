import { test, expect } from "@playwright/test";
import { step, captureDownload } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Crew journey (PRD B2): assigned → notified → job sheet → arrive → complete.
 * This spec covers browse + read + download-the-sheet; the arrive/complete legs
 * — including offline — live in scenarios/p0.spec.ts so the reliability guarantees
 * are asserted in one place.
 *
 * Runs in the "crew" project (mobile viewport, crew storageState). Assumes
 * scripts/seed-e2e.mjs has seeded SEED.crewJobCustomer with a removal tomorrow
 * and e2e-crew assigned.
 */

test.describe("Crew — my jobs", () => {
  test("sees their jobs list with an honest last-updated stamp and version", async ({ page }) => {
    await step("open /my-jobs", page, async () => {
      await page.goto("/my-jobs");
      await expect(page.getByRole("heading", { name: "My jobs" })).toBeVisible();
    });

    await step("week strip + last-updated + version are present", page, async () => {
      await expect(page.getByLabel("Your week at a glance")).toBeVisible();
      // A2: honest freshness stamp.
      await expect(page.getByText(/Updated \d{2}:\d{2}/)).toBeVisible();
      // A4: build version is visible on the crew PWA.
      await expect(page.getByText(/^v /)).toBeVisible();
    });

    await step("the seeded job appears and opens", page, async () => {
      const card = page.getByText(SEED.crewJobCustomer.name).first();
      await expect(card).toBeVisible();
      await card.click();
      await expect(page).toHaveURL(/\/my-jobs\/[0-9a-f-]{36}$/);
    });
  });

  test("opens the job sheet and reads the brief", async ({ page }) => {
    await step("open the seeded job", page, async () => {
      await page.goto("/my-jobs");
      await page.getByText(SEED.crewJobCustomer.name).first().click();
      await expect(page.getByRole("heading", { name: SEED.crewJobCustomer.name })).toBeVisible();
    });

    await step("the brief shows the customer + route (price-free)", page, async () => {
      // Eyebrow "Job sheet · <ref>" (unique — distinct from the "Job sheet (PDF)" button).
      await expect(page.getByText(`Job sheet · ${SEED.crewJobCustomer.quoteRef}`)).toBeVisible();
      await expect(page.getByText("Moving from")).toBeVisible();
      await expect(page.getByText("Moving to")).toBeVisible();
      // Crew sheets never carry money.
      await expect(page.locator("main")).not.toContainText("£");
    });

    await step("download the job-sheet PDF → artefact", page, async () => {
      // The button builds the PDF client-side (pdfmake + vfs fonts, loaded from a
      // CDN/local script). A cold Next-dev compile of this route can push that
      // load past the button's own 15s internal wait, so wait for the engine to
      // be ready BEFORE clicking — then the download fires deterministically.
      await page.waitForFunction(() => Boolean((window as unknown as { pdfMake?: { vfs?: unknown } }).pdfMake?.vfs), null, { timeout: 60_000 });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60_000 }),
        page.getByRole("button", { name: /job sheet/i }).click(),
      ]);
      const file = await captureDownload(download, "crew-job-sheet");
      expect(file).toMatch(/\.pdf$/);
      // Success toast confirms the whole build+download path completed.
      await expect(page.getByText("Job sheet downloaded.")).toBeVisible();
    });
  });
});
