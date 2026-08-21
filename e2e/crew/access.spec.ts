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

  // The (dashboard) layout bounces crew off office PAGES, but /api/** has no
  // layout — an office-only API route must refuse a crew session itself.
  // QA-20260821-01: GET /api/documents/contract/[id] served the office-only
  // signed-contract PDF (customer signature image + IP) to a crew session,
  // because its only guard is requireApiUser() (authentication, no role) and it
  // reads via the RLS-bypassing admin client. Skipped until the fix lands +
  // the E2E seed exposes a contract signature id to point at.
  test.skip("cannot fetch the office-only contract PDF (QA-20260821-01)", async ({ page }) => {
    // Un-skip in the repair PR: seed a contract signature and read its id here.
    const signatureId = process.env.E2E_CONTRACT_SIGNATURE_ID ?? "";
    const res = await page.request.get(`/api/documents/contract/${signatureId}`, { maxRedirects: 0 });
    // The fix must refuse crew (401/403), never return a PDF body.
    if (res.status() === 200) {
      const body = await res.body();
      if (body.subarray(0, 5).toString("latin1") === "%PDF-") {
        throw new Error("crew session received the office-only contract PDF");
      }
    }
  });
});
