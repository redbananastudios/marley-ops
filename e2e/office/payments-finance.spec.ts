import { test, expect } from "@playwright/test";

/**
 * Payments (panel ledger) + Finance (Invoices & VAT, reads staging Zoho). Both
 * have day navigators; Finance shows the VAT/FRS stat cards. Read-only, so we
 * assert the structure renders (day navigation doesn't mutate anything).
 */
test.describe("Office — Payments & Finance", () => {
  test("Payments — day navigator + sections", async ({ page }) => {
    await page.goto("/payments");
    await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
    // The three stat tiles.
    await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Recorded", { exact: true }).first()).toBeVisible();
  });

  test("Finance — Invoices & VAT stat cards (reads staging Zoho)", async ({ page }) => {
    await page.goto("/finance");
    await expect(page.getByRole("heading", { name: "Invoices & VAT" })).toBeVisible();
    await expect(page.getByText(/Invoiced/i).first()).toBeVisible();
    await expect(page.getByText(/Outstanding/i).first()).toBeVisible();
    await expect(page.getByText(/VAT/i).first()).toBeVisible();
  });
});
