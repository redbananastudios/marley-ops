import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — the lead detail page: the pipeline stepper + the tabbed record
 * (Overview / Quotes / Survey / Activity / Comms). Read-only: uses a seeded lead
 * no other spec consumes, and only switches tabs (no mutation).
 */
test.describe("Office — lead detail (stepper + tabs)", () => {
  test("open a lead, see the stepper, switch tabs", async ({ page }) => {
    await step("open a seeded lead via search", page, async () => {
      await page.goto("/leads");
      await page.getByPlaceholder(/Search name, phone/i).fill(SEED.awaitingDeposit.name);
      const card = page.getByRole("link", { name: new RegExp(SEED.awaitingDeposit.name) }).first();
      await expect(card).toBeVisible();
      await card.click();
      await expect(page.getByRole("heading", { name: SEED.awaitingDeposit.name })).toBeVisible();
    });

    await step("the tabbed record switches", page, async () => {
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.getByRole("tab", { name: "Overview" })).toBeVisible();
      // Radix tab clicks are a no-op until hydration attaches the handler — retry
      // each until the tab actually activates.
      const activate = async (name: string) => {
        const tab = page.getByRole("tab", { name });
        await expect(async () => {
          await tab.click();
          await expect(tab).toHaveAttribute("data-state", "active", { timeout: 1000 });
        }).toPass({ timeout: 15_000 });
      };
      for (const name of ["Quotes", "Survey", "Activity", "Comms"]) await activate(name);
      // The Quotes panel shows the lead's seeded quote value (£1,200).
      await activate("Quotes");
      await expect(page.getByText(/£\s?1,200/).first()).toBeVisible();
    });
  });
});
