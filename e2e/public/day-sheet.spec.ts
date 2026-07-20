import { test, expect } from "@playwright/test";
import { SEED } from "../fixtures/seed-data";

/**
 * /sheet/<token> — the crew member's day sheet, opened straight from the SMS
 * with NO login (token-as-credential, noindex, price-free, stale-expires). This
 * spec is also the regression guard for a real bug it surfaced: /sheet was
 * missing from the auth-proxy public allowlist, so every crew member was 307'd
 * to /login. If that regresses, `goto` lands on /login and the heading assert
 * fails.
 */
test.describe("Crew — day sheet (/sheet, no login)", () => {
  test("open the day sheet from the token and see the day's jobs", async ({ page }) => {
    await page.goto(`/sheet/${SEED.daySheet.token}`);
    await page.waitForLoadState("networkidle");
    // Proves it did NOT bounce to /login (the bug this guards).
    await expect(page).toHaveURL(/\/sheet\//);
    await expect(page.getByText(/Day sheet/i).first()).toBeVisible();
    // The seeded crew job (removal tomorrow) appears on the crew's sheet.
    await expect(page.getByText(SEED.crewJobCustomer.name).first()).toBeVisible();
    // Price-free by construction — no £ figure on a sheet that rides in the cab.
    await expect(page.getByText(/£/)).toHaveCount(0);
  });

  test("a bad token 404s", async ({ page }) => {
    const res = await page.goto("/sheet/e2e-not-a-real-token-9999");
    expect(res?.status()).toBe(404);
  });
});
