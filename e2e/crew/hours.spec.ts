import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";

/**
 * Crew hours log (/my-jobs/hours) — full ADD → EDIT → CLEAR cycle on a day
 * tile. Never had a permanent spec (qa/state.json crew.hours_log_edit_clear,
 * first tested 2026-08-20, re-verified live clean multiple times since,
 * including the 2026-08-24 QA audit via a throwaway crew login + SQL
 * read-back — 0 findings). Picks whichever day tile is currently open (not a
 * future day, not on a week with a submitted invoice) instead of hardcoding
 * "today", so it doesn't collide with another spec's submitted statement for
 * the current week (see hours-to-admin-statements.spec.ts, which submits and
 * locks "This week" as part of its own run).
 */
test.skip(
  !process.env.E2E_CREW_PASSWORD,
  "needs E2E_CREW_PASSWORD to sign in the crew fixture — set in CI, usually unset locally (see qa/state.json crew.hours_log_edit_clear)",
);

test.describe("Crew — hours log: add, edit, clear a day", () => {
  test("logs a day's hours, edits them, then clears the day", async ({ page }) => {
    let dayLabelText = "";

    await step("open /my-jobs/hours and find an open (unfilled, unlocked) day", page, async () => {
      await page.goto("/my-jobs/hours");
      await expect(page.getByRole("heading", { name: "What hours did you do?" })).toBeVisible();
      // A tile only shows "Add" when it has no entry, isn't in the future, and
      // its week isn't on a locked/submitted invoice — exactly the day we want.
      const openTile = page.getByRole("button").filter({ hasText: "Add" }).first();
      await expect(openTile).toBeVisible();
      dayLabelText = (await openTile.locator("span.text-sm.font-semibold.text-foreground").innerText()).trim();
    });

    const dayTile = () => page.getByRole("button").filter({ hasText: dayLabelText });
    const dialog = () => page.getByRole("dialog");

    await step("ADD hours for the day", page, async () => {
      await submitUntil(page, {
        prepare: async () => {
          await dayTile().click();
          await expect(dialog()).toBeVisible();
          const inputs = dialog().locator('input[type="time"]');
          await inputs.nth(0).fill("09:00");
          await inputs.nth(1).fill("16:30");
        },
        click: dialog().getByRole("button", { name: "Save", exact: true }),
        expected: dayTile().getByText("7.5 hrs"),
      });
    });

    await step("EDIT the same day's hours", page, async () => {
      await dayTile().click();
      await expect(dialog()).toBeVisible();
      const inputs = dialog().locator('input[type="time"]');
      // The dialog re-opens pre-filled from the row it's about to write back to.
      await expect(inputs.nth(0)).toHaveValue("09:00");
      await expect(inputs.nth(1)).toHaveValue("16:30");
      await submitUntil(page, {
        prepare: async () => {
          await inputs.nth(0).fill("10:15");
          await inputs.nth(1).fill("18:00");
        },
        click: dialog().getByRole("button", { name: "Save", exact: true }),
        expected: dayTile().getByText("7.75 hrs"),
      });
    });

    await step("CLEAR the day", page, async () => {
      page.once("dialog", (d) => d.accept()); // native window.confirm()
      await dayTile().click();
      await expect(dialog()).toBeVisible();
      await dialog().getByRole("button", { name: "Clear this day", exact: true }).click();
      await expect(dayTile().getByText("Add")).toBeVisible();
    });
  });
});
