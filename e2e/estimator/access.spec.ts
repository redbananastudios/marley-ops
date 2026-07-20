import { test } from "@playwright/test";
import { expectPageLoaded } from "../fixtures/ui";
import { ESTIMATOR_ROUTES } from "../fixtures/routes";

/**
 * Access matrix (estimator) — every estimator-nav route loads for an estimator.
 * The FORBIDDEN half (admin-only routes an estimator must be bounced off, e.g.
 * /finance, /finance/statements) is added once the exact gates are confirmed —
 * see estimator/gating.spec.ts.
 */
test.describe("Estimator access — every nav route loads", () => {
  for (const path of ESTIMATOR_ROUTES) {
    test(`loads ${path}`, async ({ page }) => {
      await expectPageLoaded(page, path);
    });
  }
});
