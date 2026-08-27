import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * QA-20260821-01: `GET /api/documents/contract/[signatureId]` served the
 * office-only signed-contract PDF — customer signature image, IP address,
 * timestamp — to any authenticated session, crew included. Its only guard was
 * `requireApiUser()`, which returns a user id without ever looking at a role,
 * and it reads through `createAdminClient()` (service role), so RLS could not
 * backstop the gap either. The (dashboard) layout that bounces crew off office
 * pages does not apply to /api/**.
 *
 * That route is fixed. This file exists so the NEXT one fails a test rather than
 * waiting for an audit: any API route reaching for the RLS-bypassing admin
 * client must carry a guard that checks a ROLE (or a shared secret), never bare
 * authentication.
 */
const ROOT = resolve(__dirname, "../../..");
const API_DIR = join(ROOT, "app/api");

/** Guards that establish the caller is office (or a trusted machine). */
const ROLE_AWARE = [
  "requireAdminApi", // active ADMIN only — estimators denied too (lib/ai/auth.ts)
  "requireOfficeProfile", // active admin/estimator, crew denied (lib/ai/auth.ts)
  "requireOfficeOrCronSecret", // cron secret OR active office session
  "requireUserOrCronSecret", // boolean wrapper over the above — office-gated despite the name
];

/** Authenticates only — says nothing about WHO the caller is. */
const ROLE_BLIND = ["requireApiUser"];

/**
 * Routes authenticated by a shared secret or a provider signature rather than a
 * session, so no role guard applies. Each names the mechanism standing in for
 * one: adding a path here is a deliberate claim, not a way to silence the test.
 */
const NON_SESSION_ROUTES: Record<string, string> = {
  "api/ingest/lead/route.ts": "Bearer LEAD_INGEST_SECRET (timing-safe compare)",
  "api/card/callback/route.ts": "takepayments gateway callback — verified server-side",
  "api/card/return/route.ts": "takepayments browser return — verified server-side",
  "api/webhooks/resend-inbound/route.ts": "Resend webhook signing secret",
};

/**
 * Strip comments before matching. A guard's NAME routinely appears in prose —
 * the fixed route's own docstring explains which helper was wrong and why — and
 * a mention is not a call. Scanning raw source flagged the fixed route as still
 * broken on this file's first run.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("API routes using the RLS-bypassing admin client", () => {
  const adminRoutes = routeFiles(API_DIR)
    .map((file) => {
      const rel = relative(ROOT, file).split(sep).join("/");
      return { key: rel.replace(/^app\//, ""), code: code(readFileSync(file, "utf8")) };
    })
    .filter((r) => /createAdminClient\s*\(/.test(r.code));

  const sessionGuarded = adminRoutes.filter((r) => !(r.key in NON_SESSION_ROUTES));

  it("finds the admin-client routes at all (guards against a silent zero)", () => {
    // If a refactor moves or renames these, this file must not quietly pass by
    // checking nothing — it would then prove precisely nothing.
    expect(adminRoutes.length).toBeGreaterThan(5);
    expect(sessionGuarded.length).toBeGreaterThan(0);
  });

  it("never guard with bare authentication — a role or a secret, always", () => {
    const offenders = sessionGuarded.filter((r) => ROLE_BLIND.some((g) => r.code.includes(g))).map((r) => r.key);
    expect(
      offenders,
      `read via the service role but only check that SOMEONE is logged in, so crew reach them: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("every session-guarded admin-client route names a role-aware guard", () => {
    const ungated = sessionGuarded.filter((r) => !ROLE_AWARE.some((g) => r.code.includes(g))).map((r) => r.key);
    expect(
      ungated,
      `no role-aware guard found; add one, or record the alternative mechanism in NON_SESSION_ROUTES: ${ungated.join(", ")}`,
    ).toEqual([]);
  });

  it("the contract PDF specifically is office-gated (the finding's own route)", () => {
    const contract = adminRoutes.find((r) => r.key.includes("documents/contract/"));
    expect(contract, "contract PDF route not found").toBeDefined();
    expect(contract!.code).toContain("requireOfficeProfile");
    expect(contract!.code).not.toContain("requireApiUser");
  });
});
