import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * /cv/<token> — the customer self-fill cubic survey. Token-as-credential, no
 * login, first-name-only greeting. We prove the token→survey→builder wiring and
 * that the search-first builder is interactive (adding + persisting an item is
 * exercised by the office cubic flow; here we assert the customer surface loads
 * with the seeded item and the search box works).
 */
test.describe("Customer — cubic survey (/cv)", () => {
  test("open the self-fill survey and search the catalogue", async ({ page }) => {
    await step("the token loads the customer's survey", page, async () => {
      await page.goto(`/cv/${SEED.cubicSurvey.shareToken}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: /What's moving/i })).toBeVisible();
    });

    await step("the search-first builder is interactive", page, async () => {
      const search = page.getByPlaceholder(/Search/i).first();
      await expect(search).toBeVisible();
      await search.fill("sofa");
      // A catalogue result surfaces for the typed term (proves the builder mounted
      // and the item list filters, without mutating the seeded survey).
      await expect(page.getByText(/sofa/i).first()).toBeVisible();
    });
  });

  test("a bad token 404s", async ({ page }) => {
    const res = await page.goto("/cv/e2e-not-a-real-token-9999");
    expect(res?.status()).toBe(404);
  });
});
