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

    // The login form submits via a client-side onSubmit (signInWithPassword).
    // If the button is clicked before React hydrates, the browser does a NATIVE
    // form submit (→ /login?) and no auth call fires. In a production build
    // hydration is near-instant, but dev/Turbopack is slow enough to lose the
    // race, so attempt the sign-in until we actually leave /login. Each attempt
    // re-fills because a native submit reloads the page and clears the inputs.
    let signedIn = false;
    for (let attempt = 1; attempt <= 3 && !signedIn; attempt++) {
      await page.getByLabel("Email").fill(cfg.email);
      await page.getByLabel("Password").fill(cfg.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      try {
        // The real success signal is leaving /login — wait for that FIRST (a
        // loose landing pattern can match a transient redirect hop mid-chain).
        await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 10_000 });
        signedIn = true;
      } catch {
        if (attempt === 3) throw new Error(`${role}: sign-in did not leave /login after 3 attempts`);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(600); // let hydration finish, then retry
      }
    }
    await expect(page).toHaveURL(cfg.landing);

    await page.context().storageState({ path: `${AUTH_DIR}/${role}.json` });
  });
}
