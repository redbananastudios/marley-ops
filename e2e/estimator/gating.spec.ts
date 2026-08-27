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
 * QA-20260827-01, fixed: these 7 routes had NO role gate at all — the layout
 * blocks only role==='crew', and none of the pages gated themselves, so an
 * estimator loading the URL directly got the full unredacted page (customer
 * PII, other estimators' pay and win rate, company-wide margin, signed
 * documents, the ops dashboard). Live on staging AND master until this fix.
 *
 * Each now calls `requireAdminPage()` as its first statement. These assertions
 * are the standing proof that the gate is real rather than a hidden nav link.
 */
test.describe("Estimator gating — admin-only routes with no nav entry (QA-20260827-01)", () => {
  for (const path of ["/board", "/jobs", "/clients", "/storage", "/performance", "/automations", "/documents"] as const) {
    test(`${path} is admin-only → bounced to the estimator cockpit`, async ({ page }) => {
      await expectBounced(page, path, /\/estimator/);
    });
  }
});
