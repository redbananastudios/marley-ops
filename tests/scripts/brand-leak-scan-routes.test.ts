import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { expandManifest, findLeaksInContent } from "../../scripts/brand-leak-scan.mjs";

/**
 * Coverage guard for the FIVE PUBLIC TOKEN ROUTES' import graph.
 *
 * The manifest states a rule — "a module that renders CUSTOMER-FACING COPY on a
 * brand-resolved surface belongs here, wherever it lives" — and its OK line used
 * to claim the deliberate exclusions were "named one by one". Both halves were
 * written from a hand sweep of `app/{q,s,cv,sheet,join}/[token]`, and a hand
 * sweep is the one instrument that cannot support that claim: walking the graph
 * MECHANICALLY reaches ~120 modules, and twenty of them carried a forbidden
 * literal while appearing neither in MANIFEST nor in the exclusion note. One was
 * customer email (`lib/payments/card-payments.ts`, now under scan).
 *
 * That is the same failure the sibling comms guard exists for, one level out:
 * `lib/signatures.ts` and `components/cubic/cubic-builder.tsx` were the two
 * worst leaks in the project and both sat ONE IMPORT away from a scanned folder,
 * so every run printed OK having never opened them. Being imported by a listed
 * folder is not coverage — and neither is having been eyeballed once.
 *
 * So this test makes the manifest state its own coverage of that graph. A module
 * the routes can reach, which contains a forbidden literal, must be EITHER under
 * scan OR named verbatim in the scan script's own exclusion note. There is no
 * third state where it is silently absent, and adding an import that pulls in a
 * new one forces a decision in the same change.
 *
 * What it deliberately does NOT do is decide whether the exclusion is CORRECT.
 * That is a judgement, it lives in the note's stated grounds, and a test that
 * pretended to make it would be the same overclaim in a new place. This proves
 * only that someone wrote the grounds down.
 *
 * NOTE: like its siblings, this file contains no brand literal of its own.
 */

const ROOT = process.cwd();
const SCAN_SOURCE = "scripts/brand-leak-scan.mjs";
const SCANNABLE = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx"]);

/** The five login-less customer/crew surfaces (PRD §4). Every one renders under
 *  a share token with no session, which is what makes their whole delivery chain
 *  a brand-resolved surface rather than office chrome. */
const TOKEN_ROUTES = [
  "app/q/[token]",
  "app/s/[token]",
  "app/cv/[token]",
  "app/sheet/[token]",
  "app/join/[token]",
];

/** Every `from "…"`, `import("…")` and `require("…")` specifier in a file. The
 *  three shapes are the only ones this codebase uses; a bare package specifier
 *  resolves to null below and is skipped. */
const SPECIFIERS =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

/** `@/x` and `./x` to a real file on disk, trying the extensions and the
 *  directory-index form the bundler would. Anything else (a package) is null. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  const candidates = [base, ...[...SCANNABLE].map((e) => base + e), ...[...SCANNABLE].map((e) => join(base, `index${e}`))];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && SCANNABLE.has(extname(c))) return c;
  }
  return null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCANNABLE.has(extname(entry.name))) out.push(full);
  }
  return out;
}

/** Transitive closure of the five route folders over local imports. */
function reachedFromTokenRoutes(): string[] {
  const seeds = TOKEN_ROUTES.map((r) => join(ROOT, ...r.split("/")))
    .filter((d) => existsSync(d))
    .flatMap((d) => walk(d));
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const file = queue.pop() as string;
    const key = resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const m of readFileSync(key, "utf8").matchAll(SPECIFIERS)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec) continue;
      const dep = resolveSpecifier(spec, key);
      if (dep && !seen.has(resolve(dep))) queue.push(dep);
    }
  }
  return [...seen].map((f) => relative(ROOT, f).split(sep).join("/")).sort();
}

describe("brand-leak scan — the token routes' import graph is accounted for", () => {
  const reached = reachedFromTokenRoutes();

  it("the walk is alive — it reaches well past the route folders themselves", () => {
    // Evidence discipline: an empty or route-only graph would make the coverage
    // assertion below vacuously true, which is the exact failure mode this whole
    // file exists to prevent.
    expect(reached.length).toBeGreaterThan(50);
    for (const seed of TOKEN_ROUTES) {
      expect(reached.some((f) => f.startsWith(`${seed}/`)), `${seed} must contribute files`).toBe(true);
    }
    // Two modules that are only reachable THROUGH an import — the shape the
    // 2026-09-02 pass found the worst leaks in.
    for (const f of ["lib/signatures.ts", "components/cubic/cubic-builder.tsx"]) {
      expect(reached, `${f} must be reached transitively, not directly`).toContain(f);
    }
  });

  it("every reachable module carrying a forbidden literal is scanned, or named as excluded", () => {
    const { files } = expandManifest();
    const covered = new Set<string>(files);
    const note = readFileSync(join(ROOT, SCAN_SOURCE), "utf8");

    const unaccounted: string[] = [];
    for (const file of reached) {
      // The scan script and its literal module necessarily contain every
      // literal; they can never be manifested (their own header says so).
      if (file === SCAN_SOURCE || file === "scripts/brand-leak-literals.mjs") continue;
      if (covered.has(file) || note.includes(file)) continue;
      const hits = findLeaksInContent(readFileSync(join(ROOT, file), "utf8"), file);
      if (hits.length === 0) continue;
      const literals = [...new Set(hits.map((h: { literal: string }) => h.literal))];
      unaccounted.push(`${file}   (${hits.length} hit(s): ${literals.length} distinct literal(s))`);
    }

    expect(
      unaccounted,
      `These modules are reachable from the five public token routes and contain a forbidden\n` +
        `literal, but are neither under scan nor named in the exclusion note in ${SCAN_SOURCE}.\n` +
        `A clean run therefore says nothing about them and the reader cannot tell — which is how\n` +
        `a customer-email module sat outside the manifest while the OK line claimed the exclusions\n` +
        `were named one by one. Add each to MANIFEST, or name it in the note with its grounds:\n` +
        unaccounted.join("\n"),
    ).toEqual([]);
  });

  it("puts the card rail under scan — it is customer email on a brand-resolved surface", () => {
    // The one file this walk promoted from unaccounted to manifested. Named
    // explicitly so removing it is a failing test rather than a quietly smaller
    // "everything is accounted for" set.
    const { files } = expandManifest();
    expect(files).toContain("lib/payments/card-payments.ts");
  });
});
