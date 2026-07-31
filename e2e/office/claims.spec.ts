import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — the Claims working page, driven the whole arc on ONE seeded open claim
 * (single owner, so it's order-independent): advance non-terminal (open →
 * assessing), then close it terminally (→ settled) which reveals the resolution +
 * amount fields and enforces "a terminal status needs a resolution; a goodwill
 * payment needs the amount". Verifies the settled outcome + amount render back.
 */
test.describe("Office — Claims working page", () => {
  test("advance a claim, then settle it with a resolution + amount", async ({ page }) => {
    // Opens the status Select, retrying the trigger through hydration until the
    // options mount, then picks one by label.
    async function pickStatus(label: string) {
      const trigger = page.locator("#claim-status");
      const option = page.getByRole("option", { name: label, exact: true });
      await expect(async () => {
        await trigger.click();
        await expect(option).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      await option.click();
    }

    await step("open the seeded claim from the register", page, async () => {
      await page.goto("/claims");
      await expect(page.getByRole("heading", { name: "Claims", exact: true })).toBeVisible();
      // Rows show the customer name (a span) + a CLM-ref link; scope to the row
      // carrying our seeded customer and click its CLM link.
      const row = page.locator("li", { hasText: SEED.claim.name });
      await row.getByRole("link", { name: /CLM-\d+/ }).click();
      await expect(page.getByRole("heading", { name: /Claim CLM-\d+/ })).toBeVisible();
    });

    await step("advance it to Assessing (non-terminal — no resolution needed)", page, async () => {
      await pickStatus("Assessing");
      await page.getByRole("button", { name: "Save claim" }).click();
      // Wait for the SERVER to confirm the save — the success toast fires only
      // after updateClaimAction resolves ok — before doing anything (the reload
      // below) that would abort the in-flight action. #claim-status alone is the
      // optimistic Select value: it flips instantly and proves nothing about
      // persistence, so on a slow cross-region save the reload used to race an
      // uncommitted write and read back "Open".
      await expect(page.getByText("Claim saved.")).toBeVisible({ timeout: 15_000 });
    });

    await step("reload so the settle reads a fresh concurrency token", page, async () => {
      // The claim update is a compare-and-swap on updated_at; the first save
      // bumped it. Reloading re-renders from the server, which both CONFIRMS the
      // Assessing save persisted (the value is server-derived, not the optimistic
      // Select state) and hands the form a fresh token — so the terminal save
      // below can't race a stale one on a slower target and get CAS-rejected.
      await page.reload();
      await expect(page.getByRole("heading", { name: /Claim CLM-\d+/ })).toBeVisible();
      await expect(page.locator("#claim-status")).toContainText("Assessing");
    });

    await step("settle it — resolution + amount appear and are required", page, async () => {
      await pickStatus("Settled");
      // The resolution + amount fields only exist on a terminal status. Pick a
      // goodwill payment (the resolution that REQUIRES an amount) and enter it.
      const resTrigger = page.locator("#claim-resolution");
      const goodwill = page.getByRole("option", { name: "Goodwill payment" });
      await expect(async () => {
        await resTrigger.click();
        await expect(goodwill).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      await goodwill.click();
      await page.locator("#claim-amount").fill("150");
      await page.getByRole("button", { name: "Save claim" }).click();
      // Same rule as the Assessing save: wait for the server-confirmed toast so
      // the settled state is asserted from a committed write, not the optimistic
      // Select value, on a slow cross-region round-trip.
      await expect(page.getByText("Claim saved.")).toBeVisible({ timeout: 15_000 });
    });

    await step("the claim reads as settled with the payout", page, async () => {
      // Status pill in the header flips to Settled ("Goodwill payment" also shows
      // in the still-open Select, so scope the outcome to its own paragraph).
      await expect(page.getByText("Settled").first()).toBeVisible({ timeout: 15_000 });
      const outcome = page.getByText(/Outcome:/).first();
      await expect(outcome).toContainText("Goodwill payment");
      await expect(outcome).toContainText("£150.00");
    });
  });
});
