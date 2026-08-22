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

    // Scoped to the "Start a workflow" section rather than the whole page. The
    // cockpit also lists the estimator's own assigned rows, whose link names are
    // CUSTOMER names — so a page-wide /New quote/i or /Book survey/i is one
    // unluckily-named customer away from a strict-mode violation. Not
    // hypothetical: that is exactly what took out office/quotes.spec.ts on
    // 2026-08-22. Scoping stays correct whatever the cards are labelled, because
    // the section contains only the three quick actions — which matters here,
    // where each card's accessible name also absorbs its description line.
    const startActions = page.getByRole("region", { name: "Start a workflow" });

    await step("the start-a-workflow actions are present", page, async () => {
      await expect(startActions.getByRole("link", { name: /New quote/i })).toBeVisible();
      await expect(startActions.getByRole("link", { name: /Book survey/i })).toBeVisible();
    });

    await step("open the quote builder", page, async () => {
      await startActions.getByRole("link", { name: /New quote/i }).click();
      await expect(page).toHaveURL(/\/quotes\/new/);
      // The new-quote form (add-lead in quote mode) renders its customer fields.
      await expect(page.getByRole("heading").first()).toBeVisible();
    });
  });
});
