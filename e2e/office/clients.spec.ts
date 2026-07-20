import { test, expect } from "@playwright/test";
import { openDialog } from "../fixtures/ui";
import { SEED } from "../fixtures/seed-data";

/**
 * Clients — list controls (view toggle, search) + open a client record. The
 * seed creates E2E-named clients behind its leads.
 */
test.describe("Office — Clients", () => {
  test("list: view toggle, search, open a record", async ({ page }) => {
    await page.goto("/clients");
    await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
    // Grid / List are aria-pressed segmented buttons.
    await expect(page.getByRole("button", { name: "Grid", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "List", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add client/i })).toBeVisible();

    // Search a seeded client and confirm its card links to the detail page.
    // Navigate via the href (the A–Z jump rail overlays the cards, so a direct
    // click flakes) — this still proves the card points at the right record.
    await page.getByLabel("Search clients").fill(SEED.balanceDue.name);
    const link = page.getByRole("link", { name: `Open ${SEED.balanceDue.name}` }).first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/\/clients\/[0-9a-f-]{36}/);
    await page.goto(href!);
    await expect(page.getByRole("heading", { name: SEED.balanceDue.name })).toBeVisible();
    await expect(page.getByRole("link", { name: /New quote/i })).toBeVisible();
  });

  test("add-client dialog opens", async ({ page }) => {
    await page.goto("/clients");
    const dialog = await openDialog(page, page.getByRole("button", { name: /Add client/i }));
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});
