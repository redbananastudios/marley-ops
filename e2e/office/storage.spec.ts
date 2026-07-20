import { test, expect } from "@playwright/test";
import { openDialog } from "../fixtures/ui";

/**
 * Office — Storage (sites → units → lets). Drives the create chain for real:
 * add a site, confirm it appears, then reach the Add-unit entry. Full let
 * assignment (client search + rate) is the remaining depth item; creating the
 * site proves the primary mutation. The site name is unique per run and marked
 * "E2E …" so the seed wipe cleans it.
 */
test.describe("Office — Storage", () => {
  test("create a site → reach the units entry", async ({ page }) => {
    const siteName = `E2E Flow Site ${Date.now()}`;

    await page.goto("/storage");
    await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();

    const dialog = await openDialog(page, page.getByRole("button", { name: /Add site/i }));
    await dialog.getByPlaceholder(/Shaftesbury yard/i).fill(siteName);
    await dialog.getByPlaceholder(/Ash Cottage/i).fill("1 Yard Lane, Shaftesbury");
    await dialog.getByRole("button", { name: /^Add site$/ }).click();
    await expect(dialog).toBeHidden();

    // The new site is now on the page, and units can be added to it.
    await expect(page.getByText(siteName).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Add unit/i })).toBeVisible();
  });
});
