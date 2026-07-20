import { test } from "@playwright/test";
import { expectPageLoaded, expectBounced } from "../fixtures/ui";
import { CREW_ROUTES, CREW_FORBIDDEN } from "../fixtures/routes";

/**
 * Access matrix (crew). Crew live under /my-jobs and must be BOUNCED off every
 * office/dashboard route — no crew phone should ever load leads, quotes, money
 * or settings. This is the role-isolation regression net.
 */
test.describe("Crew access", () => {
  for (const path of CREW_ROUTES) {
    test(`loads ${path}`, async ({ page }) => {
      await expectPageLoaded(page, path);
    });
  }

  for (const path of CREW_FORBIDDEN) {
    test(`is bounced off ${path}`, async ({ page }) => {
      // Crew are redirected to /my-jobs (or /login if the gate kicks to auth).
      await expectBounced(page, path, /\/my-jobs|\/login/);
    });
  }
});
