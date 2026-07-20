import { test, expect } from "@playwright/test";

/**
 * Settings — an ADMIN sees every section. The estimator-trim (only Quick
 * sign-in + Notifications, no pricing/VAT/team) is asserted in
 * estimator/settings.spec.ts. Visibility here is 100% conditional rendering, so
 * a broken canEdit check would leak money controls — this is the guard.
 */
test.describe("Office — Settings (admin sees everything)", () => {
  test("admin-only sections all render", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    // Distinctive admin-only controls across the money/team/ops sections.
    await expect(page.getByRole("button", { name: /Add user/i })).toBeVisible(); // Team
    await expect(page.getByRole("button", { name: /Save prices/i })).toBeVisible(); // Pricing
    await expect(page.getByRole("button", { name: /Save rates/i })).toBeVisible(); // Business/VAT
    await expect(page.getByText(/VAT scheme/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Run checks/i })).toBeVisible(); // Health
  });
});
