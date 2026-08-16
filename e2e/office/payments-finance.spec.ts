import { test, expect } from "@playwright/test";

/**
 * Payments (panel ledger) + Finance (Invoices & VAT, reads staging Zoho). Both
 * have day navigators; Finance shows the VAT/FRS stat cards. Read-only, so we
 * assert the structure renders (day navigation doesn't mutate anything).
 */
test.describe("Office — Payments & Finance", () => {
  test("Payments — Received ledger: range presets, method tiles, exceptions strip", async ({ page }) => {
    await page.goto("/payments");
    await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
    // Range presets (This week is the default view).
    await expect(page.getByRole("link", { name: "This week", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Last week", exact: true })).toBeVisible();
    // The method-split stat tiles.
    await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Bank transfer", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Cash", { exact: true }).first()).toBeVisible();
    // The merged day-grouped ledger.
    await expect(page.getByRole("heading", { name: "Payments received" })).toBeVisible();
    // The exceptions strip renders in exactly one of its two states.
    await expect(
      page.getByText(/Nothing unexplained|Money needing attention/).first(),
    ).toBeVisible();
  });

  test("Payments — Due tab (admin): £-totalled queues", async ({ page }) => {
    await page.goto("/payments?tab=due");
    await expect(page.getByText("Owed right now", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deposits outstanding" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "25% to collect" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Balance to collect" })).toBeVisible();
  });

  test("Payments — Upcoming tab (admin): 4-week board + pencilled pipeline", async ({ page }) => {
    await page.goto("/payments?tab=upcoming");
    await expect(page.getByText("Next 4 weeks", { exact: true })).toBeVisible();
    await expect(page.getByText("Pencilled pipeline", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("This week ·").first()).toBeVisible();
  });

  test("Finance — Invoices & VAT stat cards (reads staging Zoho)", async ({ page }) => {
    await page.goto("/finance");
    await expect(page.getByRole("heading", { name: "Invoices & VAT" })).toBeVisible();
    await expect(page.getByText(/Invoiced/i).first()).toBeVisible();
    await expect(page.getByText(/Outstanding/i).first()).toBeVisible();
    await expect(page.getByText(/VAT/i).first()).toBeVisible();
  });
});
