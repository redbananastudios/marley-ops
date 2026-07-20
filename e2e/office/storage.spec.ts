import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { openDialog } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";

/**
 * Office — Storage (sites → units → lets). Drives the FULL create-and-assign
 * chain for real: add a site, select it, add a unit under it, then assign the
 * seeded storage client to that unit at a weekly rate and confirm the unit flips
 * to Occupied showing the client + rate. Everything it makes is "E2E …" so the
 * seed wipe (which cascades sites → units → lets) cleans it.
 *
 * The client picker only offers EXISTING clients, so the assign step uses the
 * seeded `E2E Storage Client` (a real `clients` row). Giving that client a second
 * open let (it already has the /s signing let on E2E-U1) is harmless — occupancy
 * is per-unit, and the signing spec looks the let up by token, not by client.
 */
test.describe("Office — Storage", () => {
  test("create a site → add a unit → assign a client at a rate", async ({ page }) => {
    const siteName = `E2E Flow Site ${Date.now()}`;
    const unitCode = "E2E-FLOW-U1";

    await step("add a site", page, async () => {
      await page.goto("/storage");
      await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
      const dialog = await openDialog(page, page.getByRole("button", { name: /Add site/i }));
      await dialog.getByPlaceholder(/Shaftesbury yard/i).fill(siteName);
      await dialog.getByPlaceholder(/Ash Cottage/i).fill("1 Yard Lane, Shaftesbury");
      await dialog.getByRole("button", { name: /^Add site$/ }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(siteName).first()).toBeVisible();
    });

    await step("select the new site so the unit lands on it", page, async () => {
      // The initially-selected site is whatever was first-active when the view
      // mounted (a pre-existing E2E site), NOT the one we just made — so click
      // the new site's card and wait for its units section to take over.
      await page.getByText(siteName).first().click();
      await expect(page.getByText(new RegExp(`Units at ${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).toBeVisible();
    });

    await step("add a unit under it", page, async () => {
      // Scope to the dialog: there's also a page-level "Add unit" button.
      const dialog = await openDialog(page, page.getByRole("button", { name: /Add unit/i }));
      await dialog.getByPlaceholder(/20FT-01/i).fill(unitCode);
      await dialog.getByRole("button", { name: /^Add unit$/ }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(unitCode).first()).toBeVisible();
    });

    await step("assign the seeded storage client at £25/week", page, async () => {
      const dialog = await openDialog(page, page.getByRole("button", { name: "Assign client" }));
      // Search the picker and pick the existing client (picking proves hydration,
      // so the rate fill + Start let below are safe plain interactions).
      await dialog.getByPlaceholder(/Search by name, phone or email/i).fill(SEED.storageAgreement.client);
      await dialog.getByRole("button", { name: new RegExp(SEED.storageAgreement.client) }).click();
      await expect(dialog.getByText(SEED.storageAgreement.client).first()).toBeVisible();
      await dialog.getByLabel(/Rate/i).fill("25");
      await dialog.getByRole("button", { name: "Start let" }).click();
      await expect(dialog).toBeHidden();
    });

    await step("the unit is now occupied by that client at the rate", page, async () => {
      // Scope to the unit's card so the assertions can't match the seeded let.
      const card = page.locator("div", { hasText: unitCode }).filter({ hasText: SEED.storageAgreement.client }).last();
      await expect(card.getByText("Occupied")).toBeVisible();
      await expect(card.getByText(SEED.storageAgreement.client)).toBeVisible();
      await expect(card.getByText(/£25\/wk/)).toBeVisible();
    });
  });
});
