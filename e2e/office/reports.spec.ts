import { test, expect } from "@playwright/test";

/**
 * Reports & Marketing group — Performance (tabbed) + the Growth reporting pages
 * + Automations. These are read-mostly; we assert structure + a tab switch.
 */
test.describe("Office — Performance / Growth / Automations", () => {
  test("Performance — Overview/Sales/Storage tabs", async ({ page }) => {
    await page.goto("/performance");
    await expect(page.getByRole("heading", { name: "Performance", exact: true })).toBeVisible();
    // Scope to main — "Storage"/"Sales" also exist as sidebar nav links.
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "Sales", exact: true })).toBeVisible();
    await main.getByRole("link", { name: "Storage", exact: true }).click();
    await expect(page).toHaveURL(/tab=storage/);
  });

  test("Growth — Website & Tracking + Ads", async ({ page }) => {
    await page.goto("/growth");
    await expect(page.getByRole("heading", { name: "Website & Tracking" })).toBeVisible();
    await page.goto("/growth/ads");
    await expect(page.getByRole("heading", { name: "Ad proposals" })).toBeVisible();
  });

  test("Automations — log + refresh", async ({ page }) => {
    await page.goto("/automations");
    await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Refresh/i })).toBeVisible();
  });
});
