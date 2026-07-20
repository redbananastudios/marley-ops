import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { openDialog } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — marking a lead lost. The loss reason is REQUIRED (it feeds the
 * "why we lose" report), so the confirm stays disabled until one is picked.
 * Uses a dedicated seeded quoted lead so it never consumes one another spec reads.
 */
test.describe("Office — mark a lead lost (reason-gated)", () => {
  test("confirm is gated on a reason, then the lead is lost", async ({ page }) => {
    await step("open the quoted lead via search", page, async () => {
      await page.goto("/leads");
      await page.getByPlaceholder(/Search name, phone/i).fill(SEED.markLost.name);
      const card = page.getByRole("link", { name: new RegExp(SEED.markLost.name) }).first();
      await expect(card).toBeVisible();
      await card.click();
      await expect(page.getByRole("heading", { name: SEED.markLost.name })).toBeVisible();
    });

    await step("open Mark lost — confirm is disabled until a reason is chosen", page, async () => {
      const dialog = await openDialog(page, page.getByRole("button", { name: "Mark lost" }).first());
      const confirm = dialog.getByRole("button", { name: "Mark lost" });
      await expect(confirm).toBeDisabled();
      await dialog.getByRole("button", { name: "Too expensive" }).click();
      await expect(confirm).toBeEnabled();
      await confirm.click();
    });

    await step("the lead is now lost (no Mark lost action left)", page, async () => {
      await expect(page.getByRole("button", { name: "Mark lost" })).toHaveCount(0, { timeout: 15_000 });
    });
  });
});
