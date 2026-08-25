import { test, expect, type Page } from "@playwright/test";
import { expectPageLoaded } from "../fixtures/ui";
import { setBrandActive, getBrandActive } from "../fixtures/brands";

/**
 * Single-brand parity (multi-brand PRD §6 addition 1, §11.10).
 *
 * THE INVARIANT: with only Marley active, Marley Ops looks and behaves exactly
 * as it does today — no chip, no filter, no brand UI of any kind. Every brand
 * gate is provably non-regressive for the live system because deactivating the
 * Pitmans row reverts the entire brand UI. Staging seeds Pitmans active=true,
 * so this project deactivates it in beforeAll, asserts, and reactivates in
 * afterAll — which is why the `parity` project runs LAST and serially (see
 * playwright.config.ts: the ordering is load-bearing).
 *
 * THE TESTID CONTRACT — every later gate must use these, or this spec is blind:
 *   - `data-testid="brand-chip"`   → every brand chip (the 20px filled monogram
 *     square, list rows, kanban cards, detail-page eyebrows, dashboard
 *     sub-lines — ALL of them).
 *   - `data-testid="brand-filter"` → every brand filter (the segmented
 *     All / Marley / Pitmans control, wherever it lives).
 *   - `data-testid="brand-settings-card"` → the Settings › Brands card root
 *     (gate 2) — renders only in multi-brand mode, so /settings must show it
 *     never here.
 *   - `data-testid="brand-picker"` → the add-lead form's REQUIRED brand
 *     selector (gate 5 — /leads/new, and the same form reused on
 *     /quotes/new). Renders only in multi-brand mode.
 * Plus: the literal brand name ("Pitmans") must reach a page ONLY through
 * brand UI — never hardcoded, and never embedded in seeded customer/test data
 * (name seed rows "E2E …", not "Pitmans …", or assertion (d) below breaks on
 * data instead of catching a real leak).
 *
 * At gate 1 nothing renders these testids yet, so this spec passing proves the
 * BASELINE: the app in single-brand mode contains zero brand UI. As gates 3+
 * land chips and filters behind `isMultiBrand()`, the same four assertions
 * gain teeth — a chip that leaks past its gate fails here, on the exact page
 * that leaked it.
 *
 * NOTE for a first-failure diagnosis: `lib/brand.ts` deliberately has NO
 * cache — per-request reads, like `lib/settings.ts` (its header says why: a
 * cached brand surviving an activation flip is exactly the failure this spec
 * exists to catch). So if a parity assertion fails while the DB row is
 * provably inactive, suspect Next.js-level caching on the PAGE (router cache,
 * fetch memoisation) or a chip rendered outside its `isMultiBrand()` gate —
 * and if someone has since ADDED a brand cache, its invalidation is the
 * suspect. The fix is never to loosen this spec.
 */

/** Eighteen routes: the five highest-traffic office surfaces — this spec's
 *  own choice of coverage (PRD §6 addition 1 mandates the parity assertion but
 *  names no routes) — plus /settings, where gate 2's Brands card lives, plus
 *  the seven gate-4 list surfaces (clients, follow-ups, documents, claims,
 *  content, payments, refunds), plus the three gate-11 diary surfaces
 *  (schedule, removals, surveys), plus the two gate-12 surfaces (/resources
 *  and /storage). NOTE on the diaries: the hollow-unconfirmed
 *  removal rendering (dashed outline while `date_confirmed_at` is null) is
 *  deliberately NOT multi-brand-gated — Marley gets it too — so it must and
 *  does render here. It carries no brand testid and no brand text (classes
 *  `mm-evt--hollow` / `mm-evt-brand` only, and the initial span is
 *  multi-brand-only), so assertions (a)–(e) are blind to it by design. */
const PARITY_ROUTES: { path: string; heading: string }[] = [
  { path: "/", heading: "Dashboard" },
  { path: "/leads", heading: "Leads" },
  { path: "/quotes", heading: "Quotes" },
  { path: "/bookings", heading: "Bookings" },
  { path: "/leads/new", heading: "Add lead" },
  { path: "/settings", heading: "Settings" },
  { path: "/clients", heading: "Clients" },
  { path: "/follow-ups", heading: "Follow-ups" },
  { path: "/documents", heading: "Documents" },
  { path: "/claims", heading: "Claims" },
  { path: "/content", heading: "Content" },
  { path: "/payments", heading: "Payments" },
  { path: "/refunds", heading: "Refunds" },
  // Gate 11: the diary surfaces — brand × type event colours, brand filter,
  // legend and the dialog's brand picker are all multi-brand-gated, so none
  // of them may render here.
  { path: "/schedule", heading: "Schedule & Allocation" },
  { path: "/schedule/removals", heading: "Removals" },
  { path: "/schedule/surveys", heading: "Surveys" },
  // Gate 12: resources + storage. The vehicle livery chip and Livery select,
  // the job-board livery-mismatch note, storage site/let chips, the storage
  // brand filter and the site/let/manage dialogs' brand selects are all
  // multi-brand-gated, so none of them may render here. NOTE: /resources'
  // real PageHeader title is "Staff & Fleet" (the route name lies).
  { path: "/resources", heading: "Staff & Fleet" },
  { path: "/storage", heading: "Storage" },
];

/**
 * A zero-count assertion on a page that never rendered passes while proving
 * nothing. So: first prove the page loaded for this role AND its real heading
 * is up (which waits out server render), then let the page settle (client
 * components hydrate after first paint — a filter that mounts client-side
 * would be invisible to an instant count), and only then assert absence.
 */
async function expectNoBrandUi(page: Page, path: string, heading: string): Promise<void> {
  await expectPageLoaded(page, path);
  await expect(
    page.getByRole("heading", { name: heading, exact: true }).first(),
    `${path} should render its "${heading}" heading before absence is asserted`,
  ).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => {});

  // (a) No brand chip anywhere on the page.
  await expect(page.getByTestId("brand-chip"), `${path} must render zero brand chips`).toHaveCount(0);
  // (b) No brand filter anywhere on the page.
  await expect(page.getByTestId("brand-filter"), `${path} must render zero brand filters`).toHaveCount(0);
  // (c) No Brands settings card (gate 2 — only /settings can render it, and
  // only in multi-brand mode).
  await expect(
    page.getByTestId("brand-settings-card"),
    `${path} must render zero brand settings cards`,
  ).toHaveCount(0);
  // (d) The second brand's name appears nowhere — not in a chip, a tooltip, a
  // select option, an eyebrow, or a stray hardcode.
  await expect(page.getByText(/Pitmans/i), `${path} must not contain the text "Pitmans"`).toHaveCount(0);
  // (e) No brand picker (gate 5 — the add-lead form's required brand selector
  // renders only in multi-brand mode; /leads/new is in PARITY_ROUTES, so this
  // has teeth on the exact page that would leak it).
  await expect(page.getByTestId("brand-picker"), `${path} must render zero brand pickers`).toHaveCount(0);
}

test.describe("Single-brand parity — with only Marley active, no brand UI renders", () => {
  test.beforeAll(async () => {
    // Staging's default state is multi-brand; make it single-brand for the
    // duration of this project only. setBrandActive throws if the write
    // didn't take, so a failed arrange can never produce a hollow pass.
    await setBrandActive("pitmans", false);
  });

  test.afterAll(async () => {
    // Teardown THROWS on failure — it never logs and moves on. Leaving staging
    // single-brand would make every later gate look broken; #71 is the
    // standing lesson about teardowns that fail quietly. (Playwright runs
    // afterAll even when beforeAll or a spec threw, so the restore is always
    // attempted.)
    await setBrandActive("pitmans", true);

    // And prove it: a restore that changed nothing returns no error either
    // (PRD §11.10), so read the row back through an independent query rather
    // than trusting the update's own report.
    const active = await getBrandActive("pitmans");
    if (active !== true) {
      throw new Error(
        "PARITY TEARDOWN FAILED: brands.pitmans.active read back as false after reactivation. " +
          "Staging is now single-brand — restore it (update brands set active = true where slug = 'pitmans') " +
          "before trusting any other spec run.",
      );
    }
  });

  for (const { path, heading } of PARITY_ROUTES) {
    test(`no brand UI on ${path}`, async ({ page }) => {
      await expectNoBrandUi(page, path, heading);
    });
  }
});
