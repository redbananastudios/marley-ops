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
    // The money tiles. These are the two halves of the page's headline
    // identity: after QA-20260826-01 the 25% and the balance are separate
    // tiles that SUM to /payments "Owed right now" — neither one alone
    // equals it — so both must be on screen or the office is reading a
    // partial figure as a total.
    //
    // Matched on the tiles' OWN labels. They used to repeat the section
    // titles below them, so /Balance to collect/ resolved to the section
    // heading and the assertion passed with no tile on the page at all.
    await expect(page.getByText("Deposits outstanding").first()).toBeVisible();
    await expect(page.getByText("25% outstanding")).toBeVisible();
    await expect(page.getByText("Balances outstanding")).toBeVisible();
    // And the sections they decompose into, each carrying its own total.
    await expect(page.getByRole("heading", { name: "25% to collect" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Balance to collect" })).toBeVisible();

    // The seeded accepted-no-deposit quote offers a "Deposit received" dialog
    // with the payment-method choice (opened + cancelled — recording a payment
    // touches Zoho/lead state, covered by the money specs).
    const dialog = await openDialog(page, page.getByRole("button", { name: /Deposit received/i }).first());
    await expect(dialog.getByText(/Bank transfer|Cash/i).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
