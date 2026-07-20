import { test, expect } from "@playwright/test";
import { openDialog } from "../fixtures/ui";

/**
 * Bookings — the deposit→move-day board. The seeded "awaiting deposit" lead
 * drives the awaiting-deposit section (copy link + mark-paid dialog). We open
 * and cancel the mark-paid dialog rather than record a payment (that touches
 * Zoho / lead state — covered by the money specs).
 */
test.describe("Office — Bookings", () => {
  test("sections render; copy-link + mark-paid are available", async ({ page }) => {
    await page.goto("/bookings");
    await expect(page.getByRole("heading", { name: "Bookings", exact: true })).toBeVisible();
    // The three stat tiles / sections.
    await expect(page.getByText(/Awaiting deposit/i).first()).toBeVisible();
    await expect(page.getByText(/Balance outstanding/i).first()).toBeVisible();

    // The seeded accepted-no-deposit quote offers a "Deposit received" dialog
    // with the payment-method choice (opened + cancelled — recording a payment
    // touches Zoho/lead state, covered by the money specs).
    const dialog = await openDialog(page, page.getByRole("button", { name: /Deposit received/i }).first());
    await expect(dialog.getByText(/Bank transfer|Cash/i).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
