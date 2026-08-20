import { test, expect } from "@playwright/test";
import { SEED } from "../fixtures/seed-data";

/**
 * /jobs — Completed Jobs (the chronological ledger of finished moves).
 * A completed job is a lead in `completed` status; the seed's balance-due
 * customer is exactly that (completed lead + accepted quote + a removal
 * yesterday), so it must appear here with its quote ref.
 */
test.describe("Office — Completed Jobs", () => {
  test("list renders, search narrows to the seeded completed job", async ({ page }) => {
    await page.goto("/jobs");
    await expect(page.getByRole("heading", { name: "Completed Jobs", exact: true })).toBeVisible();

    // The seeded completed lead is in the ledger with its accepted quote's ref.
    const searchBox = page.getByLabel("Search completed jobs");
    await expect(searchBox).toBeVisible();
    await searchBox.fill(SEED.balanceDue.quoteRef);
    await expect(page.getByText(SEED.balanceDue.name).first()).toBeVisible();
    await expect(page.getByText(SEED.balanceDue.quoteRef).first()).toBeVisible();

    // A search matching nothing says so rather than rendering an empty region.
    await searchBox.fill("ZZZ-NO-SUCH-JOB");
    await expect(page.getByText(/No completed jobs match/i)).toBeVisible();
  });
});
