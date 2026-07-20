import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — the Follow-ups queue. The seeded follow-up is overdue (so it's DUE in
 * the queue). Marks it done with an outcome (two-step: Done → pick an outcome),
 * which closes it and drops it from the open queue.
 */
test.describe("Office — Follow-ups queue", () => {
  test("mark a due follow-up done with an outcome", async ({ page }) => {
    await step("the seeded follow-up is in the queue", page, async () => {
      await page.goto("/follow-ups");
      await expect(page.getByRole("heading", { name: "Follow-ups", exact: true })).toBeVisible();
      await expect(page.getByText(SEED.followUp.name).first()).toBeVisible();
    });

    await step("mark it done → pick an outcome", page, async () => {
      // The Done icon swaps in an already-OPEN Outcome select. Click Done (retry
      // through hydration) until the outcome options appear, then pick one.
      const done = page.getByRole("button", { name: "Done" }).first();
      const option = page.getByRole("option", { name: "Reached them" });
      await expect(async () => {
        if (await done.isVisible().catch(() => false)) await done.click();
        await expect(option).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      await option.click();
    });

    await step("it leaves the open queue", page, async () => {
      // The queue is a server component; force a fresh render, then it's gone.
      await expect(async () => {
        await page.goto("/follow-ups");
        await expect(page.getByText(SEED.followUp.name)).toHaveCount(0, { timeout: 2000 });
      }).toPass({ timeout: 15_000 });
    });
  });
});
