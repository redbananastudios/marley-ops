import { test, expect } from "@playwright/test";

/**
 * Crew availability — the self-serve "when can you work?" surface: a normal-week
 * pattern + a calendar of per-day overrides. This asserts the surface renders for
 * the crew role (heading + the normal-week row of day chips). We deliberately do
 * NOT toggle a chip here — that's an optimistic write to shared state the seed
 * would have to reset; exercising the toggle is a tracked follow-up.
 */
test.describe("Crew — availability", () => {
  test("normal week + calendar render", async ({ page }) => {
    await page.goto("/my-jobs/availability");
    await expect(page.getByRole("heading", { name: /When can you work/i })).toBeVisible();
    await expect(page.getByText(/My normal week/i)).toBeVisible();
    // The normal-week row of day chips is present.
    const chips = page.locator("button", { hasText: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|M|T|W|F|S)$/ });
    await expect(chips.first()).toBeVisible();
  });
});
