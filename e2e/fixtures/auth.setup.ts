import { test as setup, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { E2E_USERS } from "./seed-data";

/**
 * Signs in as each role via the real /login form (email + password — passkey is
 * skipped in E2E) and stores the session with storageState, so the role
 * projects start already authenticated. A missing password env var fails the
 * setup loudly rather than silently running signed-out.
 *
 * ## Why the retry below checks the form's state first
 *
 * There are two different reasons a sign-in can fail to leave /login, and they
 * need opposite responses:
 *
 *  - **The click never fired the auth call.** If the button is clicked before
 *    React hydrates, the browser does a NATIVE form submit (→ /login?) and no
 *    `signInWithPassword` happens. The page comes back in its signed-out state
 *    with the inputs cleared. The fix is to drive the form again.
 *  - **The auth call succeeded and the app is slow to redirect.** Here driving
 *    the form again is not just useless, it is actively harmful — and it hid a
 *    real defect for a full audit cycle. `login/page.tsx` sets `loading` on
 *    submit and clears it only in the error branch, so after a successful
 *    sign-in the button relabels to "Signing in…" permanently. A blind re-fill
 *    then waits 15s for a `Sign in` button that can no longer exist, and the
 *    suite reports `locator.click: Timeout 15000ms exceeded — waiting for
 *    getByRole('button', { name: 'Sign in' })`.
 *
 * That is exactly what CI run 33121391706 reported for all three roles, and it
 * reads as "the login page never rendered". It had not: the traces show every
 * role filled the form and clicked Sign in inside 100ms, and the real problem
 * was a 10–18s post-login redirect (QA-20260828-01). A test harness that
 * misnames the failure it caught is worse than one that simply fails, so this
 * loop now distinguishes the two cases and says which one it hit.
 */

const AUTH_DIR = "e2e/fixtures/.auth";
mkdirSync(AUTH_DIR, { recursive: true });

/** Per-attempt budget for the redirect off /login, once the app is warm. */
const REDIRECT_BUDGET_MS = 10_000;
/**
 * The FIRST attempt gets longer, because it is genuinely the slowest request the
 * app will serve all run.
 *
 * This job starts seconds after `docker run` replaces the container, and the
 * deploy's health check polls `/login` — which is statically prerendered, so it
 * proves the process is listening and initialises none of the module graph an
 * authenticated render needs. The first sign-in therefore pays for loading the
 * whole dashboard tree, and it blew the 10s budget three attempts running on
 * three consecutive deploys, failing the entire suite before a single test ran.
 *
 * Measured, so this is a tolerance and not a guess: a warm container serves the
 * dashboard's RSC payload in ~360ms and the whole sign-in in ~3s (every re-run of
 * those same three deploys passed). The cost is real, one-off, and belongs to the
 * deploy rather than to the app.
 *
 * Tolerating it does NOT hide it: the warning below still fires on anything over
 * the warm budget, so a genuine regression is still visible in the run output
 * rather than being absorbed into a bigger number.
 */
const FIRST_ATTEMPT_BUDGET_MS = 40_000;
/** Attempts, whether we are re-driving the form or just waiting longer. */
const ATTEMPTS = 3;

for (const [role, cfg] of Object.entries(E2E_USERS)) {
  setup(`authenticate ${role}`, async ({ page }) => {
    expect(cfg.password, `Set E2E_${role.toUpperCase()}_PASSWORD for the ${role} test user`).not.toBe("");

    await page.goto("/login");

    const signInButton = page.getByRole("button", { name: "Sign in", exact: true });
    const startedAt = Date.now();
    let signedIn = false;
    let submitted = false;

    for (let attempt = 1; attempt <= ATTEMPTS && !signedIn; attempt++) {
      // Drive the form only while it is genuinely still offering a sign-in. Once
      // the app has taken the submit, the button is gone (see the note above) and
      // the only correct move is to keep waiting.
      const formIsOffered = await signInButton.isVisible().catch(() => false);
      if (formIsOffered) {
        await page.getByLabel("Email").fill(cfg.email);
        await page.getByLabel("Password").fill(cfg.password);
        await signInButton.click();
        submitted = true;
      }

      try {
        // The real success signal is leaving /login — wait for that FIRST (a
        // loose landing pattern can match a transient redirect hop mid-chain).
        await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
          timeout: attempt === 1 ? FIRST_ATTEMPT_BUDGET_MS : REDIRECT_BUDGET_MS,
        });
        signedIn = true;
      } catch {
        if (attempt === ATTEMPTS) {
          const waited = Math.round((Date.now() - startedAt) / 100) / 10;
          // Name the failure accurately. These two need completely different
          // investigations, and conflating them is what sent the last audit
          // looking at the login page instead of the dashboard render.
          throw new Error(
            submitted
              ? `${role}: sign-in SUCCEEDED but the app did not leave /login within ${waited}s. ` +
                `The auth call fired and the form was accepted — this is a slow post-login ` +
                `render (the landing page for this role), not a broken login form.`
              : `${role}: never managed to submit the sign-in form after ${ATTEMPTS} attempts ` +
                `(${waited}s) — the form's "Sign in" button was not visible to click.`,
          );
        }
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(600); // let hydration finish, then re-check
      }
    }

    // Leaving /login proves the AUTH call landed. Arriving at this role's
    // landing page is a SECOND server render, and for two of the three roles it
    // is the slow one: `/` renders, reads the profile, and redirects estimator →
    // /estimator and crew → /my-jobs. On a cold container that redirect chain is
    // the first authenticated render the app has ever done.
    //
    // The previous fix budgeted only the first half. The assertion below then
    // ran on Playwright's default 10s and failed the estimator at exactly that
    // mark — sitting on "/" with the redirect still in flight — while crew
    // passed the identical chain in 41.8s on the SAME run, which is what proves
    // the redirect works and the container was simply cold (CI 33168865126).
    //
    // So spend one budget across both halves rather than two budgets in a row:
    // whatever the sign-in did not use is still available to the landing.
    const landingBudget = Math.max(
      REDIRECT_BUDGET_MS,
      FIRST_ATTEMPT_BUDGET_MS - (Date.now() - startedAt),
    );
    await page.waitForURL(cfg.landing, { timeout: landingBudget }).catch(() => {
      // Swallowed on purpose — the assertion below reports the real URL, which
      // is far more useful than "waitForURL timed out".
    });

    // A login that only just scraped in is a defect worth seeing, not a pass to
    // wave through: the whole 175-test suite hangs off these three steps, so a
    // creeping regression here goes from "green" to "nothing ran" with no
    // warning in between. Surfaced rather than asserted — a loaded CI runner is
    // a legitimate reason to be slow, and a flaky gate here blocks everything.
    const tookMs = Date.now() - startedAt;
    if (tookMs > REDIRECT_BUDGET_MS) {
      console.warn(
        `[auth.setup] ${role} took ${Math.round(tookMs / 100) / 10}s to sign in and land — ` +
          `over the ${REDIRECT_BUDGET_MS / 1000}s single-attempt budget. See QA-20260828-01.`,
      );
    }

    await expect(page).toHaveURL(cfg.landing);

    await page.context().storageState({ path: `${AUTH_DIR}/${role}.json` });
  });
}
