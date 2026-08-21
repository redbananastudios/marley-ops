import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — Contractor pay: reviewing a crew's SUBMITTED invoice. Drives the
 * "Return to crew" amend (the IR35-safe path — the office never silently rewrites
 * a contractor's invoice; it returns it with a reason). Uses a dedicated seeded
 * staff + submitted statement so it never touches the crew-login sign-gate.
 *
 * EVERY locator here is scoped to THIS invoice's own row, matched on its unique
 * seeded ref. "To pay" lists every contractor's submitted invoice, and the crew +
 * estimator invoicing specs each submit one of their own — for the CURRENT week,
 * which sorts ABOVE this fixture's last-week period (the page orders by
 * period_start desc). So a page-wide `getByRole("button", { name: "Return" })
 * .first()` resolves to SOMEONE ELSE'S invoice: it returns theirs and leaves this
 * one sitting in "To pay". That is exactly what happened on 2026-08-21 — the
 * reason text below landed on the estimator's MMP009 while MMP-E2E01 was never
 * touched (returned_at still null), and this spec then failed on its own
 * untouched row. Scope by ref, never by position.
 */
test.describe("Office — Contractor pay (review a submitted invoice)", () => {
  test("return a submitted invoice to the crew with a reason", async ({ page }) => {
    // The one invoice row this spec owns. `toHaveCount(1)` below is part of the
    // guard: if this ever matches more than one element the spec goes red rather
    // than quietly acting on whichever came first.
    const row = page
      .locator("div.rounded-lg.border.border-border.bg-card")
      .filter({ hasText: SEED.payCrew.statementRef });

    await step("the submitted invoice is in 'To pay'", page, async () => {
      await page.goto("/finance/statements");
      await expect(page.getByRole("heading", { name: "Contractor pay", exact: true })).toBeVisible();
      // Default filter is "To pay" (status=submitted), so matching here IS
      // matching inside that group.
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(SEED.payCrew.name);
      await expect(row.getByText(/^submitted$/i)).toHaveCount(1);
    });

    await step("return it for changes (a reason is required)", page, async () => {
      // Scoped to THIS row — the page carries one Return button per submitted
      // invoice. Retry through hydration: before React attaches, the click is a
      // no-op and the modal never opens.
      const heading = page.getByRole("heading", {
        name: new RegExp(`Return ${SEED.payCrew.statementRef} for changes`, "i"),
      });
      await expect(async () => {
        await row.getByRole("button", { name: "Return", exact: true }).click();
        await expect(heading).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      // The dialog names the invoice AND the contractor — proof we opened the
      // right one, which a `/Return .* for changes/` match could not tell.
      const dialog = page.locator("div.rounded-2xl").filter({ has: heading });
      await expect(dialog).toHaveCount(1);
      await expect(dialog).toContainText(SEED.payCrew.name);

      await page.getByPlaceholder(/please amend/i).fill("E2E: Friday was a survey, not a full day — please amend.");
      await page.getByRole("button", { name: "Return for changes" }).click();
    });

    await step("it leaves 'To pay' (now a draft with the crew)", page, async () => {
      // THIS invoice is gone from the "To pay" group…
      await expect(row).toHaveCount(0, { timeout: 15_000 });
      // …and is now a DRAFT back with the contractor. Asserting the positive
      // matters: an absence alone would also pass on an empty or errored page,
      // which would make this gate blind to the return silently not happening.
      await page.getByRole("button", { name: /^All/i }).click();
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(SEED.payCrew.name);
      await expect(row.getByText(/^draft$/i)).toHaveCount(1);
    });
  });
});
