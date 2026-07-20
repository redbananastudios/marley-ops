import { test as setup, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { E2E_USERS } from "./seed-data";

/**
 * Signs in as each role via the real /login form (email + password — passkey is
 * skipped in E2E) and stores the session with storageState, so the role
 * projects start already authenticated. A missing password env var fails the
 * setup loudly rather than silently running signed-out.
 */

const AUTH_DIR = "e2e/fixtures/.auth";
mkdirSync(AUTH_DIR, { recursive: true });

for (const [role, cfg] of Object.entries(E2E_USERS)) {
  setup(`authenticate ${role}`, async ({ page }) => {
    expect(cfg.password, `Set E2E_${role.toUpperCase()}_PASSWORD for the ${role} test user`).not.toBe("");

    await page.goto("/login");
    await page.getByLabel("Email").fill(cfg.email);
    await page.getByLabel("Password").fill(cfg.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // The real success signal is leaving /login — wait for that FIRST (a loose
    // landing pattern can match a transient redirect hop mid-chain), then
    // confirm the role's landing route.
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
    await expect(page).toHaveURL(cfg.landing);

    await page.context().storageState({ path: `${AUTH_DIR}/${role}.json` });
  });
}
