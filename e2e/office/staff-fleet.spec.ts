import { test, expect } from "@playwright/test";
import { openDialog } from "../fixtures/ui";

/**
 * Staff & Fleet (/resources) — the segmented Availability/Staff/Vehicles switch
 * and the admin add dialogs. (Estimator read-only gating is asserted elsewhere.)
 */
test.describe("Office — Staff & Fleet", () => {
  test("segmented tabs + add dialogs open", async ({ page }) => {
    await page.goto("/resources");
    await expect(page.getByRole("heading", { name: "Staff & Fleet" })).toBeVisible();
    // Segmented control = aria-pressed buttons inside a role="group".
    await expect(page.getByRole("button", { name: /^Availability/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Staff/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Vehicles/ })).toBeVisible();

    // Staff tab → the single Add button reads "Add staff".
    await page.getByRole("button", { name: /^Staff/ }).click();
    let dialog = await openDialog(page, page.getByRole("button", { name: "Add staff" }));
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Vehicles tab → the Add button reads "Add vehicle".
    await page.getByRole("button", { name: /^Vehicles/ }).click();
    dialog = await openDialog(page, page.getByRole("button", { name: "Add vehicle" }));
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
