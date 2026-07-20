import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — the Claims working page. Opens the seeded open claim and advances its
 * status (open → assessing — a non-terminal move that needs no resolution), then
 * confirms it stuck. Terminal statuses (settled/rejected) require a resolution +
 * amount and are the remaining depth item.
 */
test.describe("Office — Claims working page", () => {
  test("open a claim and advance its status", async ({ page }) => {
    await step("open the seeded claim from the register", page, async () => {
      await page.goto("/claims");
      await expect(page.getByRole("heading", { name: "Claims", exact: true })).toBeVisible();
      // Rows show the customer name (a span) + a CLM-ref link; scope to the row
      // carrying our seeded customer and click its CLM link.
      const row = page.locator("li", { hasText: SEED.claim.name });
      await row.getByRole("link", { name: /CLM-\d+/ }).click();
      await expect(page.getByRole("heading", { name: /Claim CLM-\d+/ })).toBeVisible();
    });

    await step("move it to Assessing and save", page, async () => {
      // Open the status Select, retrying the trigger through hydration until the
      // options mount, then pick Assessing.
      const trigger = page.locator("#claim-status");
      const option = page.getByRole("option", { name: "Assessing" });
      await expect(async () => {
        await trigger.click();
        await expect(option).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      await option.click();
      await page.getByRole("button", { name: "Save claim" }).click();
      // The status control reflects the saved value after revalidation.
      await expect(trigger).toContainText("Assessing", { timeout: 15_000 });
    });
  });
});
