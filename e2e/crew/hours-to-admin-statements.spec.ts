import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, deleteCrewStatements } from "../fixtures/db";
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
 * (0 findings). It shipped believing it would skip in CI for want of
 * E2E_CREW_PASSWORD/E2E_OFFICE_PASSWORD — CI has both, so it ran unvalidated on
 * its very first outing and failed twice over (QA-20260822-03): it looked for
 * the line description on a collapsed card, and it left a submitted invoice
 * behind that broke the sibling invoicing spec. Both are fixed below. The guard
 * stays for LOCAL runs, where those variables genuinely are unset.
 */
test.skip(
  !process.env.E2E_CREW_PASSWORD || !process.env.E2E_OFFICE_PASSWORD,
  "needs E2E_CREW_PASSWORD + E2E_OFFICE_PASSWORD to sign in both fixtures — set in CI, usually unset locally (see qa/state.json handoffs.h2)",
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

        // Find the invoice by what the COLLAPSED card shows — crew name and
        // total. The first version of this spec filtered on the line
        // description and always found 0: office-statements-view renders lines
        // only once a card is expanded ("expand to see the lines", and
        // `expanded` starts empty), so the description is not in the DOM yet.
        const row = officePage
          .locator("div.rounded-lg.border.border-border.bg-card")
          .filter({ hasText: "E2E Crew" })
          .filter({ hasText: "£75.00" });
        await expect(row).toHaveCount(1);
        await expect(row.getByText(/^submitted$/i)).toHaveCount(1);

        // Then open it and assert the line itself. Expanding rather than
        // dropping the check keeps the actual point of the handoff — that the
        // office reads back the crew's line IDENTICALLY, not merely that some
        // invoice for the right money exists.
        await row.getByRole("button", { expanded: false }).first().click();
        await expect(row.getByText(description)).toHaveCount(1);
        await expect(row).toContainText("5 hrs");
      });
    } finally {
      await officeContext.close();
    }
  });

  /**
   * Put the invoice back. `invoicing-submit-lines.spec.ts` documents relying on
   * starting "statement-free", which the seed guarantees against a fresh CI
   * invocation but NOT against this spec — which runs first (alphabetically) and
   * SUBMITS this week's invoice, leaving that sibling with no draft "This week"
   * can open. Leaving submitted state behind is this spec's mess to clear, not
   * something the sibling should be loosened to tolerate.
   */
  test.afterAll(async () => {
    if (!E2E_DB_READY) return;
    await deleteCrewStatements("E2E Crew");
  });
});
