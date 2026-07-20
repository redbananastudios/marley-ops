import { test, expect } from "@playwright/test";

/**
 * Dashboard — the admin landing page: period scoping + the needs-action grid.
 */
test.describe("Office — Dashboard", () => {
  test("heading, period tabs, needs-action cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    // Period tablist re-scopes the whole page.
    const week = page.getByRole("tab", { name: /This week/i });
    await expect(week).toBeVisible();
    await week.click();
    await expect(page).toHaveURL(/\/(\?|$)/);
    // At least one needs-action card links onward into the pipeline.
    await expect(page.getByText(/New enquiries to action|Follow-ups|Quotes awaiting reply/i).first()).toBeVisible();
  });
});
