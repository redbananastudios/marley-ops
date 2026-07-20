import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";

/**
 * The customer DECLINE path on /q — a customer says "not going ahead", picks a
 * reason (which feeds loss stats and stops the chase reminders). Uses its own
 * sent quote so it never consumes the accept quote.
 */
test.describe("Customer — decline (/q)", () => {
  test("decline with a reason → the thank-you state", async ({ page }) => {
    await step("open the sent quote and reveal the decline option", page, async () => {
      await page.goto(`/q/${SEED.declineQuote.acceptToken}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByText(/Ready when you are/i)).toBeVisible();
      await page.getByRole("button", { name: /Let us know/i }).click();
    });

    await step("pick a reason and decline", page, async () => {
      await submitUntil(page, {
        prepare: async () => {
          await page.getByText(/The price didn't work for us/i).click();
        },
        click: page.getByRole("button", { name: /Decline the quote/i }),
        expected: page.getByText(/Thanks for letting us know/i),
      });
    });
  });
});
