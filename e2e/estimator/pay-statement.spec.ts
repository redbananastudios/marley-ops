import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";

/**
 * Estimator contractor invoicing — the depth item pay.spec.ts (gate-only)
 * deliberately leaves out: create a statement, add a line by hand, edit it,
 * then submit. Self-contained (adds a line BY HAND rather than depending on
 * this week's survey/phone-quote/completion data existing), so it doesn't race
 * the diary/quotes state — "This week" always exists as an option regardless of
 * which day the suite runs or what else has happened on staging. Mirrors
 * e2e/crew/invoicing-submit-lines.spec.ts, adapted for the estimator's
 * fixed-fee lines (one amount field; no hours × rate).
 *
 * DEPENDENCY: seed-e2e.mjs block 13 now wipes the E2E estimator's
 * staff_statements on every seed run (mirroring the crew wipe), so a seeded run
 * always starts statement-free and "This week" is creatable. The skip below is
 * the local-run courtesy for when the seed has NOT just run — on CI it should
 * never fire, and a skip there means the reset did not happen, not that the
 * flow is fine.
 */
test.describe.serial("Estimator — invoicing: create, add a line, edit, submit", () => {
  test("the contractor agreement is signed and invoicing is unlocked", async ({ page }) => {
    await step("open My invoices", page, async () => {
      await page.goto("/estimator/pay");
      await expect(page.getByRole("heading", { name: "My invoices", exact: true })).toBeVisible();
    });

    await step("invoicing is unlocked — no gate text, the period buttons show", page, async () => {
      await expect(page.getByText(/Sign your contractor agreement first/i)).toHaveCount(0);
      await expect(page.getByText(/isn't switched on|isn't linked to a staff record/i)).toHaveCount(0);
      await expect(page.getByRole("button", { name: /This week/i })).toBeVisible();
    });
  });

  test("create a statement, add a line by hand, edit it, then submit", async ({ page }) => {
    await step("open My invoices", page, async () => {
      await page.goto("/estimator/pay");
    });

    await step("start (or reuse the draft for) this week's invoice", page, async () => {
      await page.getByRole("button", { name: /This week/i }).click();
      let created = true;
      try {
        await page.waitForURL(/\/estimator\/pay\/[0-9a-f-]{36}$/, { timeout: 8000 });
      } catch {
        created = false;
      }
      if (!created) {
        // "This week" is already submitted, so there is no draft to create
        // against. After a seed run this cannot happen (block 13 wipes the
        // estimator's statements) — so on CI this skip is itself the finding.
        test.skip(true, "This week's estimator invoice is already submitted — no draft left to create against. After a seed run this should be impossible (seed-e2e.mjs block 13 wipes the estimator's staff_statements), so a skip here means the reset did not run.");
      }
      await expect(page.getByRole("heading", { name: "What you're owed", exact: true })).toBeVisible();
    });

    const description = `E2E estimator manual line ${Date.now()}`;
    // Scoped to the line's own row: with a single line, its amount equals the
    // statement TOTAL shown above (no weekly guarantee floor for estimators, so
    // nothing pads them apart) — a bare page-wide getByText("£42.50") matches
    // both and is a strict-mode violation. The row is
    // `<div class="flex items-center gap-3 rounded-lg border border-border
    // bg-card ...">`; a bare `div` filter on `description` also matches its
    // nested description wrapper (no amount span inside THAT div) and every
    // ancestor container, so `.first()`/`.last()` on an unscoped filter picks
    // the wrong element — scope by the row's own class instead.
    const row = page.locator("div.rounded-lg.border-border.bg-card").filter({ hasText: description });

    await step("add a line by hand: £42.50", page, async () => {
      await submitUntil(page, {
        prepare: async () => {
          await page.getByRole("button", { name: "Add a line", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Add a line", exact: true })).toBeVisible();
          await page.locator("label:has-text('Description') + input").fill(description);
          await page.locator('input[type="number"]').fill("42.50");
        },
        click: page.getByRole("button", { name: "Save", exact: true }),
        expected: page.getByText(description),
      });
      await expect(row.getByText("£42.50", { exact: true })).toBeVisible();
    });

    await step("edit the line to £55.00", page, async () => {
      await row.getByLabel("Edit line").click();
      await expect(page.getByRole("heading", { name: "Edit line", exact: true })).toBeVisible();
      await page.locator('input[type="number"]').fill("55");
      await submitUntil(page, {
        click: page.getByRole("button", { name: "Save", exact: true }),
        expected: row.getByText("£55.00", { exact: true }),
      });
    });

    await step("submit the invoice", page, async () => {
      await submitUntil(page, {
        click: page.getByRole("button", { name: "Submit invoice", exact: true }),
        expected: page.getByText("Submit this invoice?"),
      });
      await submitUntil(page, {
        click: page.getByRole("button", { name: "Submit", exact: true }),
        expected: page.getByText("Submitted — the office will pay this and mark it off."),
      });
    });

    await step("submitted: no further edit controls, the office will see it as Submitted", page, async () => {
      await expect(page.getByRole("button", { name: "Add a line", exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Edit line")).toHaveCount(0);
      await expect(page.getByText(description)).toBeVisible();
    });
  });
});
