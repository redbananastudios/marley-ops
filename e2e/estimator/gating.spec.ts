import { test } from "@playwright/test";
import { expectBounced } from "../fixtures/ui";

/**
 * Estimator gating — the admin-only routes an estimator must be bounced off.
 * From the layout + per-page gates: `/finance`, `/finance/statements` and
 * `/refunds` are admin-only, and the dashboard root sends an estimator to
 * their own cockpit.
 */
test.describe("Estimator gating — admin-only routes redirect", () => {
  test("/finance is admin-only → bounced to the estimator cockpit", async ({ page }) => {
    // /finance redirects non-admins to /, which redirects an estimator to /estimator.
    await expectBounced(page, "/finance", /\/estimator$/);
  });

  test("/finance/statements (Contractor pay) → the estimator's own pay page", async ({ page }) => {
    await expectBounced(page, "/finance/statements", /\/estimator\/pay/);
  });

  test("/refunds (held-money decision queue) → the estimator's own pay page", async ({ page }) => {
    // Same admin-only gate as /finance/statements (refunds/page.tsx: estimator → /estimator/pay).
    await expectBounced(page, "/refunds", /\/estimator\/pay/);
  });

  test("the dashboard root → the estimator cockpit", async ({ page }) => {
    await expectBounced(page, "/", /\/estimator$/);
  });
});

/**
 * QA-20260827-01: these 7 routes have NO role gate at all (layout.tsx only
 * blocks role==='crew'; the pages themselves never call requireOfficeProfile())
 * — an estimator can load every one of them with full unredacted content,
 * confirmed live on staging AND on master. class:risky, Peter's fix. These
 * ship skipped and un-skip in the repair PR that adds the gate.
 */
test.describe("Estimator gating — routes with NO gate yet (QA-20260827-01)", () => {
  for (const path of ["/board", "/jobs", "/clients", "/storage", "/performance", "/automations", "/documents"] as const) {
    test.skip(`${path} should be admin-only but currently renders for estimator (QA-20260827-01)`, async ({ page }) => {
      await expectBounced(page, path, /\/estimator/);
    });
  }
});
