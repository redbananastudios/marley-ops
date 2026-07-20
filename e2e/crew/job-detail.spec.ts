import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";

/**
 * Crew job detail — the phone job sheet: route, inventory, and the private crew
 * notes (an internal record, never customer-facing). Adds a note end-to-end.
 * (Sign-off + offline behaviour are covered by crew/p0.spec.)
 */
test.describe("Crew — job detail + notes", () => {
  test("open a job, read the brief, add a crew note", async ({ page }) => {
    await step("open the seeded crew job", page, async () => {
      await page.goto("/my-jobs");
      await page.getByText(SEED.crewJobCustomer.name).first().click();
      await expect(page.getByRole("heading", { name: SEED.crewJobCustomer.name })).toBeVisible();
      // The job brief: the two route cards.
      await expect(page.getByText(/Moving from/i)).toBeVisible();
      await expect(page.getByText(/Moving to/i)).toBeVisible();
    });

    await step("add a private crew note", page, async () => {
      await page.waitForLoadState("networkidle");
      const note = `E2E crew note ${Date.now()}`;
      // submitUntil re-fills + re-clicks through the pre-hydration window (the
      // Save button's onClick is a no-op until React attaches it).
      await submitUntil(page, {
        prepare: async () => {
          const box = page.getByPlaceholder(/Add a note — damage/i);
          await box.scrollIntoViewIfNeeded();
          await box.fill(note);
        },
        click: page.getByRole("button", { name: /Save note/i }),
        expected: page.getByText(note),
      });
    });
  });
});
