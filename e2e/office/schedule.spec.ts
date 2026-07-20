import { test, expect } from "@playwright/test";

/**
 * Schedule — the survey + removal diaries. Both share the calendar view with a
 * "New appointment" create dialog. We assert the diary renders and the create
 * dialog opens (dialog cancel avoids mutating the shared diary state).
 */
test.describe("Office — Schedule", () => {
  test("survey diary loads and the new-appointment dialog opens", async ({ page }) => {
    await page.goto("/schedule/surveys");
    await expect(page.getByRole("heading", { name: "Surveys", exact: true })).toBeVisible();
    // FullCalendar toolbar.
    await expect(page.getByRole("button", { name: "Today", exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: /New appointment/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("removal diary loads with the survey overlay toggle", async ({ page }) => {
    await page.goto("/schedule/removals");
    await expect(page.getByRole("heading", { name: "Removals", exact: true })).toBeVisible();
    await expect(page.getByText(/Show surveys/i)).toBeVisible();
  });
});
