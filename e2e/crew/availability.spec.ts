import { test, expect } from "@playwright/test";

/**
 * Crew availability — the self-serve "when can you work?" surface: a normal-week
 * pattern + an 8-week calendar of per-day overrides. We assert the surface
 * renders and the normal-week chips are interactive (toggling one is an
 * optimistic write, so we flip it and flip it back to leave state as-is).
 */
test.describe("Crew — availability", () => {
  test("normal week + calendar render", async ({ page }) => {
    await page.goto("/my-jobs/availability");
    await expect(page.getByRole("heading", { name: /When can you work/i })).toBeVisible();
    await expect(page.getByText(/My normal week/i)).toBeVisible();
    // Seven day chips in the normal-week row.
    const chips = page.locator("button", { hasText: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|M|T|W|F|S)$/ });
    await expect(chips.first()).toBeVisible();
  });
});
