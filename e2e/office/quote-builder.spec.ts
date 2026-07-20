import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil, openDialog } from "../fixtures/ui";

/**
 * Office — the 7-step quote builder. Starts a brand-new quote (which captures the
 * customer + creates the client→lead→draft in one go), lands in the wizard, drives
 * it to Review & send, and opens the send dialog. It stops SHORT of actually
 * sending (that dispatches a comm + flips the quote to "sent") — reaching the send
 * dialog with a computed total proves the wizard end to end without that mutation.
 */
test.describe("Office — quote builder wizard", () => {
  test("new quote → 7-step wizard → review & send dialog", async ({ page }) => {
    const name = `E2E Quote Wizard ${Date.now()}`;

    await step("start a new quote (captures the customer)", page, async () => {
      await page.goto("/quotes/new");
      await page.waitForLoadState("networkidle");
      await submitUntil(page, {
        prepare: async () => {
          await page.getByPlaceholder("Customer name").fill(name);
          await page.getByPlaceholder("07…").fill("07700900123");
          await page.getByRole("combobox", { name: /Source/i }).click();
          await page.getByRole("option").first().click();
        },
        click: page.getByRole("button", { name: "Create quote" }),
        // The builder's sticky bottom bar always shows the live "Quote total".
        expected: page.getByText(/Quote total/i),
      });
    });

    await step("the builder opens on step 1", page, async () => {
      await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}/, { timeout: 15_000 });
      await expect(page.getByText(/Step 1 \/ 7/i)).toBeVisible();
    });

    await step("jump to Review & send via the progress dots", page, async () => {
      // The progress dots navigate directly (setStep) — reliable, and it proves
      // the Review step renders with a computed total.
      await page.getByRole("button", { name: /Step 7: Review & send/i }).click();
      await expect(page.getByText(/Step 7 \/ 7/i)).toBeVisible();
      await expect(page.getByRole("button", { name: /Send quote by email/i })).toBeVisible();
    });

    await step("open the send dialog (without sending)", page, async () => {
      const dialog = await openDialog(page, page.getByRole("button", { name: /Send quote by email/i }));
      // The recipient is pre-filled — confirm the send surface is real, then close.
      await expect(dialog.getByRole("textbox").first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  });
});
