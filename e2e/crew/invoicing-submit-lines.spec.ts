import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";

/**
 * Crew contractor invoicing — the depth item contractor.spec.ts deliberately
 * leaves out: create a statement, add a line, edit it, and submit. Self-
 * contained (adds a line BY HAND rather than depending on SEED.crewJobCustomer
 * being inside the pay period under test), so it doesn't race the calendar —
 * "This week" always exists as an option regardless of which day the suite runs.
 *
 * Relies on the same reset `scripts/seed-e2e.mjs` gives contractor.spec.ts: the
 * e2e crew's `contractor_agreements` row is deleted and its `staff_statements`
 * are wiped on every seed run, so a fresh suite invocation always starts
 * unsigned/statement-free. Signing is idempotent (23505 = already signed →
 * success) so this spec tolerates running after contractor.spec.ts in the same
 * invocation without re-signing failing.
 */
test.describe.serial("Crew — invoicing: create, add a line, edit, submit", () => {
  test("the contractor agreement is signed before invoicing", async ({ page }) => {
    await step("open My invoices", page, async () => {
      await page.goto("/my-jobs/pay");
      await expect(page.getByRole("heading", { name: /My invoices/i })).toBeVisible();
    });

    const gate = page.getByText(/Sign your contractor agreement first/i);
    if (await gate.isVisible().catch(() => false)) {
      await step("sign it", page, async () => {
        await page.goto("/my-jobs/agreement");
        await submitUntil(page, {
          prepare: async () => {
            const boxes = page.getByRole("checkbox");
            const n = await boxes.count();
            for (let i = 0; i < n; i++) await boxes.nth(i).check();
            await page.getByPlaceholder(/e\.g\. Jack Reed/i).fill("E2E Crew");
          },
          click: page.getByRole("button", { name: /Sign the contractor agreement/i }),
          expected: page.getByText(/Build an invoice for what you.re owed/i),
        });
      });
    }

    await step("invoicing is unlocked", page, async () => {
      await expect(page).toHaveURL(/\/my-jobs\/pay/);
      await expect(page.getByText(/Sign your contractor agreement first/i)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /This week/i })).toBeVisible();
    });
  });

  test("create a statement, add a line by hand, edit it, then submit", async ({ page }) => {
    await step("start (or reuse the draft for) this week's invoice", page, async () => {
      await page.goto("/my-jobs/pay");
      await submitUntil(page, {
        click: page.getByRole("button", { name: /This week/i }),
        expected: page.getByRole("heading", { name: "What you're owed", exact: true }),
      });
      await expect(page).toHaveURL(/\/my-jobs\/pay\/[0-9a-f-]{36}$/);
    });

    const description = `E2E manual line ${Date.now()}`;
    // The line row, not the header TOTAL (which shows the same figure when this
    // is the only line — a page-wide "£60.00" text match hits both).
    const row = page.locator("div.rounded-lg.border.border-border.bg-card").filter({ hasText: description });

    await step("add a line by hand: 4 hours at £15/hr = £60.00", page, async () => {
      await submitUntil(page, {
        prepare: async () => {
          await page.getByRole("button", { name: /^Add a line$/i }).click();
          await expect(page.getByRole("heading", { name: "Add a line", exact: true })).toBeVisible();
          await page.locator("label:has-text('Description') + input").fill(description);
          await page.locator("input[type=number]").nth(0).fill("4"); // Hours
          await page.locator("input[type=number]").nth(1).fill("15"); // Rate (£/hr)
        },
        click: page.getByRole("button", { name: "Save", exact: true }),
        expected: page.getByText(description),
      });
      await expect(row).toContainText("£60.00");
    });

    await step("edit the line to 6 hours = £90.00", page, async () => {
      await row.getByLabel("Edit line").click();
      await expect(page.getByRole("heading", { name: "Edit line", exact: true })).toBeVisible();
      await page.locator("input[type=number]").nth(0).fill("6"); // Hours
      await submitUntil(page, {
        click: page.getByRole("button", { name: "Save", exact: true }),
        expected: row.getByText("£90.00"),
      });
    });

    await step("submit the invoice", page, async () => {
      await submitUntil(page, {
        click: page.getByRole("button", { name: /Submit invoice/i }),
        expected: page.getByText("Submit this invoice?"),
      });
      await submitUntil(page, {
        click: page.getByRole("button", { name: "Submit", exact: true }),
        expected: page.getByText("Submitted — the office will pay this and mark it off."),
      });
    });

    await step("submitted: no further edit controls, admin will see it as Submitted", page, async () => {
      await expect(page.getByRole("button", { name: /^Add a line$/i })).toHaveCount(0);
      await expect(page.getByLabel("Edit line")).toHaveCount(0);
      await expect(page.getByText(description)).toBeVisible();
    });
  });
});
