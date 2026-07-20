import { test, expect } from "@playwright/test";
import { SEED } from "../fixtures/seed-data";

/**
 * Quotes — list presets, search, and opening a quote. (Accept → deposit invoice
 * is proven in public/customer.spec; the balance invoice in office/p0-money.)
 */
test.describe("Office — Quotes", () => {
  test("list: presets, search, open a quote", async ({ page }) => {
    await page.goto("/quotes");
    await expect(page.getByRole("heading", { name: "Quotes", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /New quote/i })).toBeVisible();

    // Preset chips.
    await expect(page.getByRole("button", { name: /^Accepted/ })).toBeVisible();

    // Server-side search by ref narrows to the seeded sent quote.
    await page.getByPlaceholder(/Search/i).first().fill(SEED.sentQuote.quoteRef);
    const row = page.getByText(SEED.sentQuote.quoteRef).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/);
    await expect(page.getByText(SEED.sentQuote.quoteRef).first()).toBeVisible();
  });
});
