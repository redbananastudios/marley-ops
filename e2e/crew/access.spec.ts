import { expect, test } from "@playwright/test";
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
  // because its only guard was requireApiUser() (authentication, no role) and it
  // reads via the RLS-bypassing admin client.
  //
  // Points deliberately at a well-formed but ABSENT id. The role gate runs before
  // the signature lookup, so the id never has to resolve — which both removes any
  // need to seed (or point at a real customer's contract) and makes the two states
  // cleanly distinguishable:
  //     pre-fix  → gate passes, lookup misses → 404
  //     post-fix → refused at the gate        → 403
  test("cannot fetch the office-only contract PDF (QA-20260821-01)", async ({ page }) => {
    const absentId = "00000000-0000-4000-8000-000000000000";
    const res = await page.request.get(`/api/documents/contract/${absentId}`, { maxRedirects: 0 });
    expect(
      res.status(),
      "crew must be refused at the role gate, not fall through to the signature lookup",
    ).toBe(403);
    expect(
      (await res.body()).subarray(0, 5).toString("latin1"),
      "crew must never receive a PDF body",
    ).not.toBe("%PDF-");
  });
});
