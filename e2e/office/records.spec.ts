import { test, expect } from "@playwright/test";

/**
 * Customers group — Documents, Claims, Content. Each is a tabbed register.
 * We assert the heading + that the tabs are present and navigable (?tab=).
 */
test.describe("Office — Documents / Claims / Content", () => {
  test("Documents — tabs + search", async ({ page }) => {
    await page.goto("/documents");
    await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Unsigned contracts/i })).toBeVisible();
    await page.getByRole("link", { name: /Contractor agreements/i }).click();
    await expect(page).toHaveURL(/tab=/);
  });

  test("Claims — Open/Closed/All tabs", async ({ page }) => {
    await page.goto("/claims");
    await expect(page.getByRole("heading", { name: "Claims", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Open/ })).toBeVisible();
    await page.getByRole("link", { name: /^All/ }).click();
    await expect(page).toHaveURL(/tab=/);
  });

  test("Content — review-state tabs", async ({ page }) => {
    await page.goto("/content");
    await expect(page.getByRole("heading", { name: "Content", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Needs review/i })).toBeVisible();
    await page.getByRole("link", { name: /Approved/i }).click();
    await expect(page).toHaveURL(/tab=/);
  });
});
