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
    // Scoped to the tile, NOT to the label text: these labels are ALSO
    // section headings further down the page, so getByText(...).first() is
    // satisfied by the section on a page with no tile at all — it could not
    // fail for the deletion it was written to catch. The tile is the element
    // carrying the £ figure, so the figure is asserted too: a tile showing
    // its label and nothing else is the same money-not-on-screen failure.
    const tile = (label: string) => page.getByTestId("stat-tile").filter({ hasText: label });
    for (const label of ["Deposits outstanding", "25% outstanding", "Balances outstanding"]) {
      await expect(tile(label), `${label} money tile`).toHaveCount(1);
      await expect(tile(label)).toBeVisible();
      await expect(tile(label)).toContainText(/£[\d,]/);
    }
    // And the sections those tiles decompose into. The two 25%/balance tiles
    // were RENAMED away from these headings precisely so a tile and a section
    // can never share a title while showing different money.
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
