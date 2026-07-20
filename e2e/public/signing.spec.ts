import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * /s/<token> — remote storage-agreement signing. The unguessable token IS the
 * credential (no login); the typed name + acknowledgments are the signature.
 * We prove the token→let→page wiring and that the sign affordance renders; we
 * deliberately don't POST the signature (it's a one-shot that would flip the
 * seeded let to "already signed", breaking idempotent re-runs — the sign action
 * itself is unit-covered in lib/signatures).
 */
test.describe("Customer — storage agreement (/s)", () => {
  test("open the signing page for an unsigned let", async ({ page }) => {
    await step("the token loads the customer's storage agreement", page, async () => {
      await page.goto(`/s/${SEED.storageAgreement.signToken}`);
      await page.waitForLoadState("networkidle");
      // First-name-only greeting (never the address/phone — the iMVE leak we fixed).
      await expect(page.getByRole("heading", { name: /Your storage with us/i })).toBeVisible();
    });

    await step("the signature affordance is present", page, async () => {
      await expect(page.getByPlaceholder(/e\.g\. Jane Smith/i)).toBeVisible();
      await expect(page.getByRole("button", { name: /Sign the storage agreement/i })).toBeVisible();
    });
  });

  test("a bad token 404s (never leaks another customer's let)", async ({ page }) => {
    const res = await page.goto("/s/e2e-not-a-real-token-9999");
    expect(res?.status()).toBe(404);
  });
});
