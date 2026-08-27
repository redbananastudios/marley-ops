import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every office page states its own access level in its own source.
 *
 * `app/(dashboard)/layout.tsx` bounces only `role === "crew"`, so an office page
 * that gates nothing is readable by every estimator who types its URL. Until
 * 2026-08-27 seven of them did exactly that in production (QA-20260827-01):
 * `/clients` listed 28 real customers with phone, email and postcode;
 * `/performance` showed other estimators' win rate and fee owed alongside
 * per-job margin; `/documents` showed signed contracts with signer identity.
 * The only thing standing between an estimator and any of it was the absence of
 * a link in the sidebar.
 *
 * A per-page conditional that has to be remembered is a gate that gets
 * forgotten on page eight, so the enforcement is mechanical: this map is the
 * checked-in record of what each route intends, and a page whose source stops
 * matching it fails here. Adding a page fails too — deliberately. Deciding who
 * may read a new office surface is the author's job, not a default.
 *
 * Levels:
 *  - `admin`   — calls `requireAdminPage()` (or an equivalent inline
 *                `role !== "admin"` redirect). Bulk customer PII, other
 *                people's pay, company-wide money, signed documents, ops.
 *  - `office`  — calls `requireOfficeProfile()`. Admin and estimator, crew denied.
 *  - `redacts` — no redirect, but reads the role and withholds admin-only
 *                content (`/resources` hides crew pay rates; `/clients/[id]`
 *                hides the edit controls). A deliberate read-with-less, not an
 *                oversight — see the note beside each entry.
 *  - `open`    — every signed-in office user, nothing role-dependent on the page.
 */

/** Path (relative to `app/(dashboard)`) → intended access level. */
const EXPECTED: Record<string, "admin" | "office" | "redacts" | "open"> = {
  // Admin-only. All seven below were `open` until QA-20260827-01.
  "/automations": "admin",
  "/board": "admin",
  "/clients": "admin",
  "/documents": "admin",
  "/jobs": "admin",
  "/performance": "admin",
  "/storage": "admin",
  // Admin-only already, and the precedent the seven were fixed against.
  "/finance": "admin",
  "/finance/statements": "admin",
  "/refunds": "admin",

  // Office (admin + estimator), crew denied.
  "/claims": "office",
  "/claims/[id]": "office",
  "/content": "office",

  // Role-aware without redirecting — the estimator reaches these legitimately
  // and sees less. Changing either to `admin` would break the estimator's
  // quoting workflow, so the redaction is the design, not a shortfall.
  "/clients/[id]": "redacts", // record they are quoting; edit controls hidden
  "/resources": "redacts", // crew pay rates hidden (RLS withholds the rows too)

  // Reachable by any office user by design — the estimator's own surfaces, the
  // shared diary, and the pages their sidebar links to.
  "/": "open", // redirects estimator → /estimator
  "/bookings": "open",
  "/estimator": "open",
  "/estimator/pay": "office", // the estimator's own invoices
  "/estimator/pay/[id]": "office",
  "/follow-ups": "open",
  "/leads": "open",
  "/leads/[id]": "redacts",
  "/leads/[id]/cubic": "open",
  "/leads/[id]/cubic/review": "office",
  "/leads/[id]/cubic/scan": "office",
  "/leads/new": "open",
  "/manual": "redacts", // admin-only sections hidden
  "/payments": "redacts",
  "/quotes": "open",
  "/quotes/[id]": "open",
  "/quotes/new": "open",
  "/schedule": "redacts",
  "/schedule/removals": "open",
  "/schedule/surveys": "open",
  "/settings": "redacts", // trims itself to the estimator's own cards
};

const DASHBOARD = join(__dirname, "../../app/(dashboard)");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

/** `app/(dashboard)/leads/[id]/page.tsx` → `/leads/[id]`; the root → `/`. */
function routeOf(file: string): string {
  const rel = relative(DASHBOARD, file).split(sep).slice(0, -1).join("/");
  return rel ? `/${rel}` : "/";
}

function levelOf(source: string): "admin" | "office" | "redacts" | "open" {
  if (/requireAdminPage\(\)/.test(source)) return "admin";
  // The same gate written longhand, from before the helper existed (`/finance`).
  // The condition must be the WHOLE test: `role !== "estimator" && role !==
  // "admin"` also ends in `!== "admin")` but permits the estimator, so a looser
  // pattern would report the estimator's own pay page as admin-only.
  if (/if\s*\(\s*profile\??\.role\s*!==\s*"admin"\s*\)\s*redirect\(/.test(source)) return "admin";
  if (/requireOfficeProfile\(\)/.test(source)) return "office";
  // Longhand office gate: admin and estimator pass, everyone else redirects.
  if (/role\s*!==\s*"estimator"\s*&&[^)]*role\s*!==\s*"admin"/.test(source)) return "office";
  // No redirect, but the page branches on the role to withhold something.
  if (/role\s*===\s*"admin"/.test(source)) return "redacts";
  return "open";
}

describe("dashboard route access levels", () => {
  const actual = new Map(
    routeFiles(DASHBOARD).map((f) => [routeOf(f), levelOf(readFileSync(f, "utf8"))] as const),
  );

  it("has an entry for every dashboard page, and a page for every entry", () => {
    // A new page defaults to nothing, so it must be classified here on the way
    // in rather than discovered by an audit months later.
    expect([...actual.keys()].filter((r) => !(r in EXPECTED)).sort()).toEqual([]);
    expect(Object.keys(EXPECTED).filter((r) => !actual.has(r)).sort()).toEqual([]);
  });

  it.each(Object.entries(EXPECTED))("%s is %s", (route, level) => {
    expect(actual.get(route)).toBe(level);
  });

  /**
   * The regression itself, stated as the property that failed: nothing an
   * estimator cannot see in the sidebar may be readable by typing its URL.
   */
  it("no route outside the estimator's sidebar is left ungated", () => {
    const ESTIMATOR_NAV = [
      "/estimator",
      "/leads",
      "/follow-ups",
      "/schedule/surveys",
      "/quotes",
      "/bookings",
      "/payments",
      "/estimator/pay",
      "/settings",
      "/manual",
    ];
    const reachableFromNav = (route: string) =>
      route === "/" || ESTIMATOR_NAV.some((n) => route === n || route.startsWith(`${n}/`));

    const ungatedAndHidden = [...actual.entries()]
      .filter(([route, level]) => !reachableFromNav(route) && level === "open")
      .map(([route]) => route)
      .sort();

    // `/schedule/removals` is the shared diary: absent from the estimator's
    // sidebar but reachable by design from the surveys view they do have, and
    // it carries no pay, margin or bulk-PII content. (`/schedule` itself reads
    // the role and withholds the admin-only allocation controls.) Anything
    // joining this list is a decision, and failing here is how it gets made.
    expect(ungatedAndHidden).toEqual(["/schedule/removals"]);
  });
});
