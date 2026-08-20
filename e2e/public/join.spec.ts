import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_SINK_EMAIL, E2E_SINK_PHONE, SEED } from "../fixtures/seed-data";

/**
 * /join/<token> — the crew sign-up link: one shared unguessable token Peter
 * drops in the crew WhatsApp group, gated by `business_settings.staff_onboard_enabled`
 * + `staff_onboard_token`. Unlike the other public specs (/s, /sheet, /cv), there
 * is nothing to pre-seed as a "pending application" — the row IS what the form
 * creates — so the seed only switches the feature ON and pins a stable token
 * (`SEED.joinApplicant.token`, mirroring the `self_billing_enabled` toggle; see
 * scripts/seed-e2e.mjs #14) and this spec drives a REAL submission.
 *
 * Contact fields use the shared E2E sink, never a fresh throwaway address:
 * `submitStaffOnboardingAction` updates a still-PENDING row with the same
 * email+phone in place rather than stacking a duplicate, so re-running this
 * spec without a reseed stays idempotent (the seed also hard-clears any prior
 * "E2E %" application outright, so a re-seeded run always starts unclaimed).
 */
test.describe("Crew — sign-up (/join)", () => {
  test("submit the crew application and see the success state", async ({ page }) => {
    await step("the token loads the sign-up form", page, async () => {
      await page.goto(`/join/${SEED.joinApplicant.token}`);
      await page.waitForLoadState("networkidle");
      // Proves the link is genuinely live (staff_onboard_enabled=true) rather
      // than the deliberately-identical "This link isn't active" dead-link
      // card — a disabled feature fails right here, not later.
      await expect(page.getByRole("heading", { name: /Join the crew/i })).toBeVisible();
    });

    await step("fill in the application with marker data", page, async () => {
      await page.locator("#jn-name").fill(SEED.joinApplicant.name);
      await page.locator("#jn-dob").fill("1990-01-01");
      await page.locator("#jn-address").fill("1 Test Street");
      await page.locator("#jn-town").fill("Shaftesbury");
      await page.locator("#jn-postcode").fill("SP7 8AA");
      await page.locator("#jn-email").fill(E2E_SINK_EMAIL);
      await page.locator("#jn-phone").fill(E2E_SINK_PHONE);
      await page.getByRole("button", { name: "Yes", exact: true }).click();
      await page.locator("#jn-notes").fill(`${SEED.joinApplicant.name} — E2E-SEED, safe to delete`);
    });

    await step("submit and see the confirmation", page, async () => {
      await page.getByRole("button", { name: /Send my details/i }).click();
      const firstName = SEED.joinApplicant.name.split(" ")[0];
      await expect(page.getByRole("heading", { name: new RegExp(`Thanks ${firstName}`, "i") })).toBeVisible();
      await expect(page.getByText(/The office has your details and will be in touch/i)).toBeVisible();
    });
  });

  test("a bad token fails gracefully, never the real form", async ({ page }) => {
    // /join has no per-token 404: a wrong token and a switched-off link render
    // the SAME "This link isn't active" card on purpose (DeadLinkCard — the URL
    // must give nothing away about which). The crash-safety bar here is that it
    // renders that clean card, not a raw error/stack trace, and never the form.
    const res = await page.goto("/join/e2e-not-a-real-token-9999");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: /This link isn.t active/i })).toBeVisible();
    await expect(page.locator("#jn-name")).toHaveCount(0);
  });
});
