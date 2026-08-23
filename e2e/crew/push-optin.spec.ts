import { test, expect } from "@playwright/test";

/**
 * QA-20260823-04. Crew must NOT be offered a push opt-in, because since bd58fa0
 * retired the crew_job category every remaining category is office-only: tapping
 * Enable would spend the browser's one-shot permission prompt and then deliver
 * nothing, forever, silently — and a denied prompt is close to unrecoverable.
 *
 * The unit test (tests/lib/push/categories.test.ts) guards the CAUSE — that no
 * category names crew in its audience. This guards the WIRING: that /my-jobs
 * passes the viewer's role and NotificationsRow gates on it. Asserting the row's
 * absence alone would also pass if the whole section broke, so the surrounding
 * "Your device" items are asserted present in the same breath.
 */
test("crew are not offered a push opt-in that cannot deliver anything", async ({ page }) => {
  await page.goto("/my-jobs");

  // The section rendered — so an absence below is a gate, not a blank page.
  await expect(page.getByRole("heading", { name: "Your device" })).toBeVisible();
  await expect(page.getByRole("link", { name: /User manual/i })).toBeVisible();

  await expect(page.getByText("Get alerts on this phone", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Get job alerts on this phone", { exact: true })).toHaveCount(0);
  // The retired promise itself, in any wording that still names the old feature.
  await expect(page.getByText(/put on a job/i)).toHaveCount(0);
});
