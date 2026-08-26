import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { step } from "../fixtures/artefacts";

/**
 * Handoff h5 (QA audit ledger, qa/state.json): a customer submits a crew
 * sign-up via the public /join/<token> page → an admin approves it in
 * Staff & Fleet → a new `staff` row is created (crew role), carrying the
 * submission's details verbatim. This is the "approve" leg only — approval
 * does NOT create an auth.users/profiles login (a deliberate 3-step
 * approve/activate/invite design), so there is no "new crew login works"
 * assertion here on purpose.
 *
 * Proven live against staging 2026-08-26 by two concurrent QA-SENTINEL
 * role-agents (a public /join submission + a throwaway admin login, both
 * service-role minted): the submission landed as staff_submissions.status
 * "pending", the admin's Approve click flipped it to "approved" with
 * reviewed_by = the admin's own profile id, and a new staff row appeared
 * with full_name copied exactly from the submission (still containing the
 * QA-SENTINEL marker) and no auth.users/profiles row for the applicant.
 * 0 findings — matches the design note already on staff_vehicle_crud_join_approve
 * in qa/state.json.
 *
 * Ships SKIPPED: this environment has no persistent E2E_OFFICE_PASSWORD (the
 * `.auth/office.json` storageState fixture `auth.setup.ts` needs), matching
 * the existing pattern for handoff specs in this repo (see
 * e2e/office/crew-assignment-to-myjobs.spec.ts, h9). Un-skip once it's set —
 * expected to actually pass, not blocked by any known bug.
 */
test.skip(
  !process.env.E2E_OFFICE_PASSWORD,
  "needs E2E_OFFICE_PASSWORD to sign in the office fixture — set in CI, usually unset locally (see qa/state.json handoffs.h5)",
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const dbReady = !!url && !!serviceKey;

function db() {
  if (!dbReady) throw new Error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");
  if (url.includes("supabase.redbananastudios.com")) {
    throw new Error(`E2E refuses to touch the PRODUCTION Supabase host (${url}).`);
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

const MARKER = "QA-SENTINEL h5 spec";
const APPLICANT_NAME = `${MARKER} Applicant`;
let submissionId: string;
let staffId: string | null = null;

test.describe.serial("Handoff h5 — /join submission → admin approves in Staff & Fleet", () => {
  test.beforeAll(async () => {
    if (!dbReady) return;
    const sb = db();
    // Clean any stale row from a previous failed run before seeding.
    await sb.from("staff").delete().ilike("full_name", `%${APPLICANT_NAME}%`);
    await sb.from("staff_submissions").delete().ilike("full_name", `%${APPLICANT_NAME}%`);

    const { data: settings } = await sb
      .from("business_settings")
      .select("staff_onboard_token, staff_onboard_enabled")
      .limit(1)
      .maybeSingle();
    if (!settings?.staff_onboard_enabled || !settings?.staff_onboard_token) {
      throw new Error("business_settings.staff_onboard_enabled/staff_onboard_token must be set for this spec");
    }
    (test.info() as unknown as { joinToken?: string }).joinToken = settings.staff_onboard_token;
  });

  test("customer: submit a crew application via /join", async ({ page, browserName: _browserName }, testInfo) => {
    const token = (testInfo as unknown as { joinToken?: string }).joinToken;
    await step("the token loads the sign-up form", page, async () => {
      await page.goto(`/join/${token}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { name: /Join the crew/i })).toBeVisible();
    });

    await step("fill in and submit the application with marker data", page, async () => {
      await page.locator("#jn-name").fill(APPLICANT_NAME);
      await page.locator("#jn-dob").fill("1994-03-11");
      await page.locator("#jn-address").fill("12 QA Sentinel Lane");
      await page.locator("#jn-town").fill("Shaftesbury");
      await page.locator("#jn-postcode").fill("SP7 8AB");
      await page.locator("#jn-email").fill("qa-sentinel-h5@marleymoves.test");
      await page.locator("#jn-phone").fill("07700900982");
      await page.getByRole("button", { name: "Yes", exact: true }).click();
      await page.getByRole("button", { name: /Send my details/i }).click();
      await expect(page.getByRole("heading", { name: /Thanks QA-SENTINEL/i })).toBeVisible();
    });
  });

  test("admin: the pending submission appears and Approve creates a staff row", async ({ browser }) => {
    const adminContext = await browser.newContext({ storageState: "e2e/fixtures/.auth/office.json" });
    const adminPage = await adminContext.newPage();
    try {
      await step("the submission shows in the Staff & Fleet review queue", adminPage, async () => {
        await adminPage.goto("/resources");
        await adminPage.waitForLoadState("networkidle").catch(() => {});
        await expect(adminPage.getByText(APPLICANT_NAME, { exact: true }).first()).toBeVisible();
      });

      await step("approve the submission", adminPage, async () => {
        const card = adminPage
          .getByText(APPLICANT_NAME, { exact: true })
          .locator("xpath=ancestor::div[.//button[contains(., 'Approve')]][1]");
        await card.getByRole("button", { name: "Approve", exact: true }).click();
        await expect(adminPage.getByText(/added to staff/i)).toBeVisible();
      });

      await step("the review card is gone from the pending queue", adminPage, async () => {
        await adminPage.reload();
        await adminPage.waitForLoadState("networkidle").catch(() => {});
        await expect(adminPage.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
      });
    } finally {
      await adminContext.close();
    }
  });

  test("SQL: submission approved, staff row created, no login row", async () => {
    test.skip(!dbReady, "needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
    const sb = db();

    const { data: submission, error: sErr } = await sb
      .from("staff_submissions")
      .select("id, status, reviewed_by, staff_id, full_name")
      .ilike("full_name", `%${APPLICANT_NAME}%`)
      .maybeSingle();
    if (sErr) throw sErr;
    expect(submission?.status).toBe("approved");
    expect(submission?.reviewed_by).toBeTruthy();
    expect(submission?.staff_id).toBeTruthy();
    submissionId = submission!.id;
    staffId = submission!.staff_id as string;

    const { data: staff, error: stErr } = await sb
      .from("staff")
      .select("id, full_name, staff_role")
      .eq("id", staffId!)
      .maybeSingle();
    if (stErr) throw stErr;
    expect(staff?.full_name).toBe(submission!.full_name);
    expect(staff?.staff_role).toBe("crew");

    // Approving a sign-up creates a staff record only — no login. If this
    // ever changes, it's a deliberate design change, not something this spec
    // should silently start expecting.
    const { data: authList } = await sb.auth.admin.listUsers({ perPage: 200 });
    const applicantAuthUser = authList?.users?.find((u) => u.email?.toLowerCase() === "qa-sentinel-h5@marleymoves.test");
    expect(applicantAuthUser).toBeUndefined();
  });

  test.afterAll(async () => {
    if (!dbReady) return;
    const sb = db();
    if (staffId) await sb.from("staff").delete().eq("id", staffId);
    else await sb.from("staff").delete().ilike("full_name", `%${APPLICANT_NAME}%`);
    if (submissionId) await sb.from("staff_submissions").delete().eq("id", submissionId);
    else await sb.from("staff_submissions").delete().ilike("full_name", `%${APPLICANT_NAME}%`);
  });
});
