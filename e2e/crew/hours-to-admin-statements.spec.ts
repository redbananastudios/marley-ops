import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";

/**
 * Handoff h2 (QA audit ledger, qa/state.json): crew logs hours → the office
 * sees them on /finance/statements once submitted. Never had a permanent spec
 * — invoicing-submit-lines.spec.ts proves the crew side (create/add/edit/
 * submit) but stops at the crew's own screen. This spec is the missing other
 * half: it opens a SECOND browser context using the office's own storageState
 * and confirms the submitted line reads back identically from the office UI —
 * same crew name, same description, same amount. A silent drop or a
 * mismatched read here would mean crew invoices office can't see or trust.
 *
 * Proven live against staging 2026-08-22 by a throwaway QA-SENTINEL login pair
 * (0 findings) — ships test.skip'd because this environment has no
 * E2E_CREW_PASSWORD/E2E_OFFICE_PASSWORD, so auth.setup.ts can't sign in the
 * persistent e2e-crew/e2e-office fixtures this spec depends on. Un-skip once
 * those creds are available and confirm green.
 */
test.skip(
  !process.env.E2E_CREW_PASSWORD || !process.env.E2E_OFFICE_PASSWORD,
  "needs E2E_CREW_PASSWORD + E2E_OFFICE_PASSWORD to sign in both fixtures — unset in this environment (see qa/state.json handoffs.h2)",
);

test.describe.serial("Handoff — crew submits an invoice, office sees it on /finance/statements", () => {
  const description = `E2E h2 handoff line ${Date.now()}`;

  test("crew: create a statement, add a line, submit it", async ({ page }) => {
    await step("invoicing is unlocked", page, async () => {
      await page.goto("/my-jobs/pay");
      await expect(page.getByRole("heading", { name: /My invoices/i })).toBeVisible();
      await expect(page.getByText(/Sign your contractor agreement first/i)).toHaveCount(0);
    });

    await step("start (or reuse the draft for) this week's invoice", page, async () => {
      await submitUntil(page, {
        click: page.getByRole("button", { name: /This week/i }),
        expected: page.getByRole("heading", { name: "What you're owed", exact: true }),
      });
      await expect(page).toHaveURL(/\/my-jobs\/pay\/[0-9a-f-]{36}$/);
    });

    const row = page.locator("div.rounded-lg.border.border-border.bg-card").filter({ hasText: description });

    await step("add a line by hand: 5 hours at £15/hr = £75.00", page, async () => {
      await submitUntil(page, {
        prepare: async () => {
          await page.getByRole("button", { name: /^Add a line$/i }).click();
          await expect(page.getByRole("heading", { name: "Add a line", exact: true })).toBeVisible();
          await page.locator("label:has-text('Description') + input").fill(description);
          await page.locator("input[type=number]").nth(0).fill("5"); // Hours
          await page.locator("input[type=number]").nth(1).fill("15"); // Rate (£/hr)
        },
        click: page.getByRole("button", { name: "Save", exact: true }),
        expected: page.getByText(description),
      });
      await expect(row).toContainText("£75.00");
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
  });

  test("office: the submitted line reads back identically on /finance/statements", async ({ browser }) => {
    // A second, independent context signed in as the office — the "role that
    // should see it confirms in ITS browser" proof the QA audit's handoff
    // lens requires, not just a shared DB read.
    const officeContext = await browser.newContext({ storageState: "e2e/fixtures/.auth/office.json" });
    const officePage = await officeContext.newPage();
    try {
      await step("office sees the crew's submitted line", officePage, async () => {
        await officePage.goto("/finance/statements");
        await expect(officePage.getByRole("heading", { name: "Contractor pay", exact: true })).toBeVisible();
        const row = officePage.locator("div.rounded-lg.border.border-border.bg-card").filter({ hasText: description });
        await expect(row).toHaveCount(1);
        await expect(row).toContainText("E2E Crew");
        await expect(row).toContainText("£75.00");
        await expect(row.getByText(/^submitted$/i)).toHaveCount(1);
      });
    } finally {
      await officeContext.close();
    }
  });
});
