import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — Contractor pay: reviewing a crew's SUBMITTED invoice. Drives the
 * "Return to crew" amend (the IR35-safe path — the office never silently rewrites
 * a contractor's invoice; it returns it with a reason). Uses a dedicated seeded
 * staff + submitted statement so it never touches the crew-login sign-gate.
 */
test.describe("Office — Contractor pay (review a submitted invoice)", () => {
  test("return a submitted invoice to the crew with a reason", async ({ page }) => {
    await step("the submitted invoice is in 'To pay'", page, async () => {
      await page.goto("/finance/statements");
      await expect(page.getByRole("heading", { name: "Contractor pay", exact: true })).toBeVisible();
      await expect(page.getByText(SEED.payCrew.name).first()).toBeVisible();
    });

    await step("return it for changes (a reason is required)", page, async () => {
      // The action buttons live inside the expanded row — expand it first
      // (retry through hydration until Return appears), then open the modal.
      const returnBtn = page.getByRole("button", { name: "Return", exact: true }).first();
      await expect(async () => {
        await page.getByRole("button", { name: new RegExp(SEED.payCrew.name) }).first().click();
        await expect(returnBtn).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });

      const heading = page.getByRole("heading", { name: /Return .* for changes/i });
      await expect(async () => {
        await returnBtn.click();
        await expect(heading).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });

      await page.getByPlaceholder(/please amend/i).fill("E2E: Friday was a survey, not a full day — please amend.");
      await page.getByRole("button", { name: "Return for changes" }).click();
    });

    await step("it leaves 'To pay' (now a draft with the crew)", page, async () => {
      await expect(page.getByText(SEED.payCrew.name)).toHaveCount(0, { timeout: 15_000 });
    });
  });
});
