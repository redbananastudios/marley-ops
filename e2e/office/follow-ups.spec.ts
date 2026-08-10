import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — the Follow-ups queue. The seeded follow-up is overdue (so it's DUE in
 * the queue). Marks it done with an outcome (two-step: Done → pick an outcome),
 * which closes it and drops it from the open queue.
 *
 * Both action menus are DropdownMenu (role=menuitem), not Select (role=option).
 * They were Select bound to value="", which never resolves a selected item, so
 * Radix's item-aligned positioning skipped its offset maths and the panel opened
 * at the top-left of the viewport instead of under the button. The anchoring
 * test below is the guard against that coming back.
 */
test.describe("Office — Follow-ups queue", () => {
  test("snooze menu opens anchored to its button, not at the top of the page", async ({ page }) => {
    await page.goto("/follow-ups");
    await expect(page.getByRole("heading", { name: "Follow-ups", exact: true })).toBeVisible();

    const trigger = page.getByRole("button", { name: "Snooze" }).first();
    const menuItem = page.getByRole("menuitem", { name: "In a fortnight" });
    await expect(async () => {
      if (await trigger.isVisible().catch(() => false)) await trigger.click();
      await expect(menuItem).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    const triggerBox = await trigger.boundingBox();
    const menuBox = await page.getByRole("menu").first().boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(menuBox).not.toBeNull();

    // The bug put the panel at y≈0 regardless of where the card sat. Assert it
    // tracks its trigger rather than a hardcoded offset, so this still holds if
    // the menu flips above the button near the bottom of the viewport.
    const gap = Math.min(
      Math.abs(menuBox!.y - (triggerBox!.y + triggerBox!.height)),
      Math.abs(triggerBox!.y - (menuBox!.y + menuBox!.height)),
    );
    expect(gap).toBeLessThan(50);
    // Horizontally it should overlap the trigger too (align="end").
    expect(menuBox!.x).toBeLessThanOrEqual(triggerBox!.x + triggerBox!.width);
    expect(menuBox!.x + menuBox!.width).toBeGreaterThanOrEqual(triggerBox!.x);

    await page.keyboard.press("Escape");
  });

  test("mark a due follow-up done with an outcome", async ({ page }) => {
    await step("the seeded follow-up is in the queue", page, async () => {
      await page.goto("/follow-ups");
      await expect(page.getByRole("heading", { name: "Follow-ups", exact: true })).toBeVisible();
      await expect(page.getByText(SEED.followUp.name).first()).toBeVisible();
    });

    await step("mark it done → pick an outcome", page, async () => {
      // The Done icon swaps in an already-OPEN outcome menu. Click Done (retry
      // through hydration) until the options appear, then pick one.
      const done = page.getByRole("button", { name: "Done" }).first();
      const option = page.getByRole("menuitem", { name: "Reached them" });
      await expect(async () => {
        if (await done.isVisible().catch(() => false)) await done.click();
        await expect(option).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      await option.click();
    });

    await step("it leaves the open queue", page, async () => {
      // The queue is a server component; force a fresh render, then it's gone.
      await expect(async () => {
        await page.goto("/follow-ups");
        await expect(page.getByText(SEED.followUp.name)).toHaveCount(0, { timeout: 2000 });
      }).toPass({ timeout: 15_000 });
    });
  });
});
