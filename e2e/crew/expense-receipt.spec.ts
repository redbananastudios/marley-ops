import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";

/**
 * Crew hours log (/my-jobs/hours) — the expense + receipt-photo half of the day
 * tile, never covered anywhere under e2e/ (grepped "receipt|expense", 0 matches
 * before this file — flagged as a spec gap by the 2026-08-23 and 2026-08-24 QA
 * audits, closed here). hours.spec.ts covers the plain ADD/EDIT/CLEAR hours
 * cycle on a day with no expense; this spec is the sibling flow: fill an amount
 * + note, attach a receipt photo, and confirm the upload round-trips (the
 * button flips to "Receipt saved/sent"), re-proved live by the 2026-08-24 QA
 * audit via a throwaway crew login + storage/DB read-back (real object bytes,
 * FFD8FF/FFD9 JPEG magic, receipt_key matching the bucket object) — 0 findings.
 * Picks whichever day tile is currently open, same reason as hours.spec.ts:
 * avoids colliding with another spec's submitted-invoice week.
 */
test.skip(
  !process.env.E2E_CREW_PASSWORD,
  "needs E2E_CREW_PASSWORD to sign in the crew fixture — set in CI, usually unset locally (see qa/state.json crew.expense_receipt_upload)",
);

// Minimal valid 1x1 JPEG (FFD8...FFD9) — small enough to skip the client-side
// downscale's createImageBitmap path failing in a headless context, large
// enough to carry real JPEG magic bytes end to end.
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

test.describe("Crew — hours log: expense + receipt photo", () => {
  test("logs an expense and attaches a receipt photo", async ({ page }) => {
    let dayLabelText = "";

    await step("open /my-jobs/hours and find an open (unfilled, unlocked) day", page, async () => {
      await page.goto("/my-jobs/hours");
      await expect(page.getByRole("heading", { name: "What hours did you do?" })).toBeVisible();
      const openTile = page.getByRole("button").filter({ hasText: "Add" }).first();
      await expect(openTile).toBeVisible();
      dayLabelText = (await openTile.locator("span.text-sm.font-semibold.text-foreground").innerText()).trim();
    });

    const dayTile = () => page.getByRole("button").filter({ hasText: dayLabelText });
    const dialog = () => page.getByRole("dialog");

    await step("fill hours + expense amount/note, attach a receipt photo", page, async () => {
      await dayTile().click();
      await expect(dialog()).toBeVisible();
      const inputs = dialog().locator('input[type="time"]');
      await inputs.nth(0).fill("08:00");
      await inputs.nth(1).fill("16:30");
      await dialog().locator('input[type="number"]').fill("23.45");
      await dialog().getByPlaceholder("Fuel, parking…").fill("QA e2e receipt");

      const fileChooserPromise = page.waitForEvent("filechooser").catch(() => null);
      await dialog()
        .getByRole("button", { name: /Photo of the receipt|Receipt (saved|sent to accounts)/ })
        .click();
      const chooser = await fileChooserPromise;
      if (chooser) {
        await chooser.setFiles({
          name: "receipt.jpg",
          mimeType: "image/jpeg",
          buffer: Buffer.from(TINY_JPEG_BASE64, "base64"),
        });
      } else {
        // Hidden <input type=file> without a native chooser event in this browser context.
        await dialog().locator('input[type="file"]').setInputFiles({
          name: "receipt.jpg",
          mimeType: "image/jpeg",
          buffer: Buffer.from(TINY_JPEG_BASE64, "base64"),
        });
      }

      await expect(dialog().getByText(/Receipt (saved|sent to accounts) — replace it/)).toBeVisible({
        timeout: 20_000,
      });

      await dialog().getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog()).not.toBeVisible({ timeout: 10_000 });
    });

    await step("the day tile shows the expense pill", page, async () => {
      await expect(dayTile().getByText("£23.45")).toBeVisible();
    });
  });
});
