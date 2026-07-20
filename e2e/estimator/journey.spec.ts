import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";

/**
 * Estimator journey (PRD B2): the estimator signs in to their workspace, sees
 * their day, and can start a quote. Runs in the "estimator" project (estimator
 * storageState).
 *
 * The full 7-step quote build + send + PDF assertion is a deep flow best driven
 * against staging with a seeded priced quote; this journey proves the estimator
 * can reach their cockpit and open the quote builder (the daily entry point).
 */
test.describe("Estimator — workspace", () => {
  test("lands on the day view and can start a quote", async ({ page }) => {
    await step("the estimator cockpit loads", page, async () => {
      await page.goto("/estimator");
      await expect(page.getByRole("heading", { name: /My day/i })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Your surveys/i })).toBeVisible();
    });

    await step("the start-a-workflow actions are present", page, async () => {
      await expect(page.getByRole("link", { name: /New quote/i })).toBeVisible();
      await expect(page.getByRole("link", { name: /Book survey/i })).toBeVisible();
    });

    await step("open the quote builder", page, async () => {
      await page.getByRole("link", { name: /New quote/i }).click();
      await expect(page).toHaveURL(/\/quotes\/new/);
      // The new-quote form (add-lead in quote mode) renders its customer fields.
      await expect(page.getByRole("heading").first()).toBeVisible();
    });
  });
});
