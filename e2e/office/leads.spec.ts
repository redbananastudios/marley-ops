import { test, expect } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { submitUntil } from "../fixtures/ui";

/**
 * Leads — the list surface + the add-lead create flow. Created leads are
 * E2E-named so the seed wipe reclaims them.
 */
test.describe("Office — Leads", () => {
  test("list: heading, search, presets, add-lead entry", async ({ page }) => {
    await page.goto("/leads");
    await expect(page.getByRole("heading", { name: "Leads", exact: true })).toBeVisible();
    await expect(page.getByPlaceholder(/Search name, phone/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /Add lead/i })).toBeVisible();
    // Compact cards retain their primary footer actions and move secondary
    // controls into the per-lead overflow menu.
    const firstMenu = page.getByRole("button", { name: /More actions for/i }).first();
    await expect(firstMenu).toBeVisible();
    await expect(page.getByRole("link", { name: /New quote for/i }).first()).toBeVisible();
    await firstMenu.click();
    await expect(page.getByRole("menuitem", { name: "Open lead" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByTestId("leads-table")).toBeVisible();
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page.getByTestId("leads-board")).toBeVisible();
    // Preset chips filter the list — clicking one must not error and stays on /leads.
    await page.getByRole("button", { name: /^Uncontacted/ }).first().click();
    await expect(page).toHaveURL(/\/leads/);
  });

  test("board responds at desktop, tablet and mobile widths without page overflow", async ({ page }) => {
    await page.goto("/leads");
    const board = page.getByTestId("leads-board");

    const expectColumns = async (count: number) => {
      await expect(board).toBeVisible();
      await expect.poll(() => board.evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
      )).toBe(count);
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      )).toBe(true);
    };

    await page.setViewportSize({ width: 1280, height: 900 });
    await expectColumns(3);
    await page.setViewportSize({ width: 900, height: 900 });
    await expectColumns(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectColumns(1);
  });

  test("add a lead → lands on the new lead's detail page", async ({ page }) => {
    const name = `E2E New Lead ${Date.now()}`;
    await step("open the add-lead form", page, async () => {
      await page.goto("/leads/new");
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: "Add lead" })).toBeVisible();
    });
    await step("fill the required fields and submit", page, async () => {
      // submitUntil re-fills through the pre-hydration native-submit reload.
      await submitUntil(page, {
        prepare: async () => {
          await page.getByPlaceholder("Customer name").fill(name);
          await page.getByPlaceholder("07…").fill("07700900123");
          // Source is a required Select — open it and pick the first option.
          await page.getByRole("combobox", { name: /Source/i }).click();
          await page.getByRole("option").first().click();
        },
        click: page.getByRole("button", { name: "Add lead" }),
        expected: page.getByRole("heading", { name }),
      });
    });
    await step("the lead was created", page, async () => {
      await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 15_000 });
      await expect(page.getByRole("heading", { name })).toBeVisible();
    });
  });
});
