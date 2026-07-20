import { test, expect } from "@playwright/test";

/**
 * Estimator — My invoices (/estimator/pay). The seed links the estimator to a
 * staff row, switches self-billing on, and signs their contractor agreement, so
 * all three gates pass and the invoice builder entry is available (no sign-first
 * gate, no "not linked", no "not switched on"). Building an actual invoice is the
 * remaining depth item.
 */
test.describe("Estimator — pay (invoicing unlocked)", () => {
  test("the invoice builder entry is available", async ({ page }) => {
    await page.goto("/estimator/pay");
    await expect(page.getByRole("heading", { name: "My invoices", exact: true })).toBeVisible();
    // Gates passed → the start-an-invoice entry shows, and none of the block states do.
    await expect(page.getByRole("button", { name: /Start an invoice/i }).first()).toBeVisible();
    await expect(page.getByText(/Sign your contractor agreement first/i)).toHaveCount(0);
    await expect(page.getByText(/isn't switched on|isn't linked to a staff record/i)).toHaveCount(0);
  });
});
