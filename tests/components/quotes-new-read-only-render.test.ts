import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * QA-20260828-02 — /quotes/new?leadId= must not write during its render.
 *
 * The page used to call createDraftQuote() and redirect() inside the Server
 * Component render. Next can invoke that render twice for one client-side
 * navigation; the DB race was handled (quotes_one_draft_per_lead_uq +
 * re-read-the-winner) but the two redirect() throws were not, so any of the
 * seven <Link prefetch={false}> entry points could intermittently crash the
 * soft navigation to the generic error boundary while the draft committed
 * underneath (first reproduced at one entry point as QA-20260827-03).
 *
 * The fix keeps the render read-only and delegates creation to
 * CreateDraftAndOpen, a client component that makes ONE deterministic
 * server-action call after mount and then navigates. Asserted as source
 * guards per the house convention in tests/components (this repo has no
 * jsdom/RTL setup — vitest runs `environment: 'node'`): the properties worth
 * locking are structural. Every lookup goes through `at()`, which FAILS on a
 * missing needle, so a rename cannot make these assertions pass vacuously.
 */

/**
 * Read with line endings NORMALISED to LF. `core.autocrlf=true` on Windows
 * materialises these .tsx files with CRLF, so the multi-line page-shell needle
 * below returns -1 there while passing in CI, which checks out LF on Linux.
 * That is the worst shape a gate can take — green on the machine nobody
 * debugs on, red on the only machine the suite is run on by hand — because
 * the local run gets abandoned as broken rather than trusted, and AGENTS.md's
 * first e2e habit depends on it being runnable. Same root cause as the *.mjs
 * and *.snap pins in .gitattributes; normalising at the read keeps the fix
 * local to the assertions that actually care about layout.
 */
const readSource = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const PAGE = readSource("app/(dashboard)/quotes/new/page.tsx");
const OPENER = readSource("app/(dashboard)/quotes/new/create-draft-and-open.tsx");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

describe("/quotes/new renders read-only and delegates the draft write", () => {
  it("the page performs no write and no redirect during its render", () => {
    // The write-during-render was the whole bug: the page must not touch
    // createDraftQuote (or any redirect of its result) in the render pass.
    expect(
      PAGE.includes("createDraftQuote"),
      "page.tsx calls createDraftQuote during render again — QA-20260828-02 regressed",
    ).toBe(false);
    expect(
      PAGE.includes("redirect("),
      "page.tsx redirect()s during render again — QA-20260828-02 regressed",
    ).toBe(false);
  });

  it("the leadId branch hands off to the client-side opener instead", () => {
    at(PAGE, "CreateDraftAndOpen", "the hand-off to the client opener");
    // The hand-off keeps the dashboard page-shell rule (AGENTS.md 2026-07-16):
    // this early return is a page root too, so it must carry the shell.
    const branch = at(PAGE, "if (leadId) {", "the leadId branch");
    const shell = at(
      PAGE,
      '<main className="flex-1 p-6 md:p-8">\n        <CreateDraftAndOpen',
      "the page shell around the opener",
    );
    expect(shell, "the opener renders outside the leadId branch").toBeGreaterThan(branch);
  });

  it("the opener is a client component that fires the action exactly once", () => {
    at(OPENER, '"use client"', "the client directive");
    at(OPENER, "createDraftQuote({ leadId })", "the single server-action call");
    // The strict-mode guard is what makes "exactly once" true, not hopeful.
    at(OPENER, "if (fired.current) return;", "the single-fire effect guard");
    at(OPENER, "fired.current = true;", "the guard being armed");
    // replace, not push: the interstitial must not become a back-button trap
    // that re-runs the creation flow.
    at(OPENER, "router.replace(`/quotes/${res.id}`)", "the replace-navigation to the draft");
  });

  it("failure renders a message instead of throwing into the error boundary", () => {
    at(OPENER, "setError(res.error ||", "the surfaced action error");
    const throws = OPENER.match(/throw new Error/g) ?? [];
    expect(throws.length, "the opener throws — that is the error boundary the fix removes").toBe(0);
  });
});
