import { test } from "@playwright/test";
import { expectBounced } from "../fixtures/ui";

/**
 * Estimator gating — the admin-only routes an estimator must be bounced off.
 * From the layout + per-page gates: `/finance` and `/finance/statements` are
 * admin-only, and the dashboard root sends an estimator to their own cockpit.
 * (Every other office route renders for estimators — covered by access.spec.)
 */
test.describe("Estimator gating — admin-only routes redirect", () => {
  test("/finance is admin-only → bounced to the estimator cockpit", async ({ page }) => {
    // /finance redirects non-admins to /, which redirects an estimator to /estimator.
    await expectBounced(page, "/finance", /\/estimator$/);
  });

  test("/finance/statements (Contractor pay) → the estimator's own pay page", async ({ page }) => {
    await expectBounced(page, "/finance/statements", /\/estimator\/pay/);
  });

  test("the dashboard root → the estimator cockpit", async ({ page }) => {
    await expectBounced(page, "/", /\/estimator$/);
  });
});
