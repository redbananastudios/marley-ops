import { test, expect } from "@playwright/test";
import { openDialog } from "../fixtures/ui";

/**
 * Storage — sites → units → lets. We assert the page + the add-site dialog
 * (creating a full site/unit/let chain mutates a lot of state and is best left
 * to a dedicated seeded flow; the dialog open proves the entry point works).
 */
test.describe("Office — Storage", () => {
  test("page renders; add-site dialog opens", async ({ page }) => {
    await page.goto("/storage");
    await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
    const dialog = await openDialog(page, page.getByRole("button", { name: /Add site/i }));
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
