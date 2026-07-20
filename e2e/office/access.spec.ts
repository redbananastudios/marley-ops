import { test } from "@playwright/test";
import { expectPageLoaded } from "../fixtures/ui";
import { OFFICE_ROUTES } from "../fixtures/routes";

/**
 * Access matrix (admin) — every office route renders for an admin without
 * bouncing to /login or hitting an error boundary. This is the broad regression
 * net: a page that 500s, loses its gate, or breaks on deploy fails here.
 * Deep feature behaviour is covered per-flow elsewhere.
 */
test.describe("Office access — every route loads for an admin", () => {
  for (const path of OFFICE_ROUTES) {
    test(`loads ${path}`, async ({ page }) => {
      await expectPageLoaded(page, path);
    });
  }
});
