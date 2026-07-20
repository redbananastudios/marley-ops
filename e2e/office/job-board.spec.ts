import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { openDialog } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — the Job Board (the week's jobs + per-day resource capacity, assignment
 * by modal). We assert it renders with the seeded resources, that week navigation
 * works, and drive the ASSIGN MODAL open on a seeded removal (the iPad-reliable
 * assignment path). We open the modal rather than drag-drop a rail chip — drag is
 * inherently flaky to automate and the modal exercises the same assign action.
 */
test.describe("Office — Job Board", () => {
  test("resources, week nav, and the assign modal", async ({ page }) => {
    await step("the board loads with the resource rail", page, async () => {
      await page.goto("/schedule/board");
      await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
      // The rail (open on desktop) lists the seeded fleet.
      await expect(page.getByText(SEED.vehicle.name).first()).toBeVisible();
    });

    await step("week navigation controls work", page, async () => {
      await page.getByRole("button", { name: "Next week" }).click();
      await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
      await page.getByRole("button", { name: "Previous week" }).click();
      await expect(page.getByRole("heading", { name: "Job Board" })).toBeVisible();
    });

    await step("open the assign modal on a seeded removal", page, async () => {
      // Seeded removals are TOMORROW — this week, or next week if today is Sunday.
      const assign = () => page.getByRole("button", { name: /Assign staff \/ vehicle/i }).first();
      if ((await assign().count()) === 0) await page.getByRole("button", { name: "Next week" }).click();
      const dialog = await openDialog(page, assign());
      await expect(dialog.getByText(/^Assign —/)).toBeVisible();
      // The modal offers the seeded crew + van to assign.
      await expect(dialog.getByText(SEED.vehicle.name).first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  });
});
