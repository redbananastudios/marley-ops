import { test, expect } from "@playwright/test";

/**
 * Settings is trimmed for estimators by conditional rendering (no redirect), so
 * a broken canEdit check would silently leak pricing/VAT/team/money controls.
 * This is the leak guard: an estimator sees ONLY their own device + agreement
 * cards, and none of the admin-only sections.
 */
test.describe("Estimator — Settings is trimmed", () => {
  test("only self-service cards; no admin money/team controls", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    // Their own cards.
    await expect(page.getByText(/Quick sign-in/i).first()).toBeVisible();
    await expect(page.getByText(/Notifications/i).first()).toBeVisible();
    await expect(page.getByText(/Contractor agreement/i).first()).toBeVisible();
    // Admin-only controls must be ABSENT from the DOM (not just hidden).
    await expect(page.getByRole("button", { name: /Add user/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save prices/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save rates/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Run checks/i })).toHaveCount(0);
    await expect(page.getByText(/VAT scheme/i)).toHaveCount(0);
  });
});
