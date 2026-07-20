import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";

/**
 * Crew contractor invoicing — the agreement GATE, then the unlock. Self-employed
 * crew must sign the contractor agreement once before they can build invoices
 * (the IR35-safe, HMRC-friendly gate). The seed switches the feature on, gives the
 * crew a £15/hr rate, and clears any prior signature so this starts unsigned.
 *
 * Serial: the "gate is shown" assertion must run BEFORE the sign test consumes it.
 * (Building/submitting an actual invoice is the next depth item — tracked in
 * COVERAGE.md — kept out of here so the spec stays idempotent without per-run
 * statement teardown beyond the seed.)
 */
test.describe.serial("Crew — contractor invoicing", () => {
  test("My invoices shows the sign-first gate before signing", async ({ page }) => {
    await page.goto("/my-jobs/pay");
    await expect(page.getByRole("heading", { name: /My invoices/i })).toBeVisible();
    await expect(page.getByText(/Sign your contractor agreement first/i)).toBeVisible();
  });

  test("sign the agreement → invoicing unlocks", async ({ page }) => {
    await step("open the agreement from the gate", page, async () => {
      await page.goto("/my-jobs/agreement");
      await expect(page.getByRole("heading", { name: "Contractor agreement", exact: true })).toBeVisible();
    });

    await step("tick every acknowledgment, type a name, and sign", page, async () => {
      await submitUntil(page, {
        prepare: async () => {
          const boxes = page.getByRole("checkbox");
          const n = await boxes.count();
          for (let i = 0; i < n; i++) await boxes.nth(i).check();
          await page.getByPlaceholder(/e\.g\. Jack Reed/i).fill("E2E Crew");
        },
        click: page.getByRole("button", { name: /Sign the contractor agreement/i }),
        // On success it routes to /my-jobs/pay with the invoice builder unlocked.
        expected: page.getByText(/Build an invoice for what you.re owed/i),
      });
    });

    await step("the invoicing surface is now available", page, async () => {
      await expect(page).toHaveURL(/\/my-jobs\/pay/);
      await expect(page.getByText(/Sign your contractor agreement first/i)).toHaveCount(0);
    });
  });
});
