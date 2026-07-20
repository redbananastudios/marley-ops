import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Customer journey (PRD B2): the public accept page /q/<token>. No auth (the
 * "public" project).
 *
 * The quote VIEW is testable now. The accept → deposit-invoice leg raises a real
 * invoice in Zoho, so it's gated on a STAGING Zoho org id (ZOHO_ORG_ID numeric —
 * never Connor's live org). The card-deposit leg additionally needs the
 * takepayments sandbox and lives in P0 #6.
 */

// True only when ZOHO_ORG_ID is a real numeric org id (staging), not the E2E dummy.
const ZOHO_STAGING = /^\d+$/.test(process.env.ZOHO_ORG_ID ?? "");

test.describe("Customer — accept page (/q)", () => {
  test("the sent quote renders on the public link", async ({ page }) => {
    await step("open the customer quote link", page, async () => {
      await page.goto(`/q/${SEED.sentQuote.acceptToken}`);
      await expect(page.getByText("Your removal quote")).toBeVisible();
      await expect(page.getByText(SEED.sentQuote.quoteRef)).toBeVisible();
      // gbp() strips .00 → £1,500.
      await expect(page.getByText("£1,500")).toBeVisible();
    });

    await step("the accept form + deposit terms are shown", page, async () => {
      await expect(page.getByText(/deposit secures the booking/i)).toBeVisible();
      await expect(page.getByLabel("Your full name")).toBeVisible();
      await expect(page.getByRole("button", { name: /Accept quote & pay/i })).toBeVisible();
    });
  });

  test("accept online → deposit invoice raised (needs the Zoho staging org)", async ({ page }) => {
    test.skip(!ZOHO_STAGING, "Set ZOHO_ORG_ID to the staging Zoho Invoice org id to run the accept→deposit-invoice leg.");

    await step("tick the acknowledgments, sign by name, accept", page, async () => {
      await page.goto(`/q/${SEED.sentQuote.acceptToken}`);
      const boxes = page.getByRole("checkbox");
      const n = await boxes.count();
      for (let i = 0; i < n; i++) await boxes.nth(i).check();
      await page.getByLabel("Your full name").fill("E2E Sent Quote");
      await page.getByRole("button", { name: /Accept quote & pay/i }).click();
    });

    await step("lands on the pay screen — a deposit invoice exists in the staging org", page, async () => {
      // The accepted → pay view: BACS panel + the deposit CTA.
      await expect(page.getByText(/deposit to secure your date/i)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Pay by bank transfer/i)).toBeVisible();
    });
  });
});
