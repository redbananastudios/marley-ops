#!/usr/bin/env node
/**
 * Brand-leak scan — the SOURCE half (multi-brand PRD §6 addition 4; §10
 * "Where the brand-leak scan lives").
 *
 * A "brand-resolved" file is one whose output is meant to be correct for ANY
 * brand because everything brand-specific arrives as data from the `brands`
 * table. Such a file may not contain ANY brand's literals — not the default
 * brand's, not the second brand's — in code OR comments. One hardcoded name,
 * domain, phone number or brand-colour token in a shared template is exactly
 * the class of leak this catches mechanically (the office phone number
 * appears nine times in /q alone; the class is what matters, not the
 * instance).
 *
 * THE MANIFEST GROWTH CONTRACT: only files matched by MANIFEST are scanned.
 * A file not listed is NOT clean — it is UNSCANNED. As each gate brands a
 * surface (converts its hardcoded identity to `brands`-table reads), that
 * gate adds the newly brand-resolved paths to MANIFEST in the same PR, so the
 * scan's coverage grows in lockstep with the refactor and a later edit can
 * never quietly re-hardcode a literal. Never remove an entry to get a run
 * green — fix the leak (PRD §10: leak hits in existing code are findings to
 * fix in the same gate).
 *
 * THE SPLIT (PRD §10): this script is the source grep. The RENDERED-PAGE half
 * — a Playwright assertion over the second brand's pages on staging, catching
 * what a grep can't see through a token — lands with gate 16 as an e2e spec.
 * Neither half caps or substitutes for the other; a green source scan says
 * nothing about rendered output, and this header says so rather than letting
 * the gap be silent.
 *
 * Evidence discipline (house rule: "I could not check" must never render as
 * "nothing to report"): a manifest pattern that matches no files is an ERROR,
 * and a run that scanned zero files FAILS — a scan that scanned nothing must
 * never print clean.
 *
 * This script itself necessarily contains every forbidden literal (the list
 * below), so it must never be added to MANIFEST. The vitest twin
 * (tests/brand-leak-scan.test.ts) imports and runs the same check so it rides
 * `npm test` with no package.json change; run standalone with
 * `node scripts/brand-leak-scan.mjs`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Forbidden literals per PRD §6.4, both directions. `ci: true` matches
 * case-insensitively (domains, phones, tokens, mailboxes); name literals stay
 * case-SENSITIVE on purpose — the lowercase brand slugs (`marley`,
 * `pitmans`) are data keys (DEFAULT_BRAND, `?brand=` values, data-brand
 * attributes) and are legal everywhere.
 */
export const FORBIDDEN = [
  // Default-brand literals that must not reach a second-brand-capable surface.
  { literal: "Marley", brand: "marley", ci: false },
  { literal: "marleymoves.co.uk", brand: "marley", ci: true },
  { literal: "01747 637070", brand: "marley", ci: true },
  { literal: "01747637070", brand: "marley", ci: true },
  { literal: "Connor", brand: "marley", ci: false },
  { literal: "connor@", brand: "marley", ci: true }, // the mailbox form a case-sensitive "Connor" misses
  { literal: "mm-red", brand: "marley", ci: true }, // the brand-colour Tailwind token — colour comes from brands.colour_primary
  // Reverse direction: second-brand literals must not be hardcoded either.
  { literal: "Pitmans", brand: "pitmans", ci: false },
  { literal: "pitmansremovals.co.uk", brand: "pitmans", ci: true },
  { literal: "01258 858564", brand: "pitmans", ci: true },
  { literal: "01258858564", brand: "pitmans", ci: true },
];

/**
 * Brand-resolved source globs, repo-relative with forward slashes. Grows gate
 * by gate — see THE MANIFEST GROWTH CONTRACT above. Supported forms: an exact
 * file path, `dir/**` (every file beneath), and `*` single-segment wildcards.
 */
export const MANIFEST = [
  "components/brand/**",
  "lib/brand-filter.ts",
  // Gate 5: the lead page's change-brand control — fully data-driven (names
  // and colours arrive as brands-table rows via props).
  "app/(dashboard)/leads/[id]/brand-changer.tsx",
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next"]);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** One path segment against one pattern segment, `*` = any run of chars. */
function segmentMatches(patternSeg, pathSeg) {
  const parts = patternSeg.split("*");
  if (parts.length === 1) return patternSeg === pathSeg;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!pathSeg.startsWith(first) || !pathSeg.endsWith(last)) return false;
  let pos = first.length;
  for (const part of parts.slice(1, -1)) {
    const idx = pathSeg.indexOf(part, pos);
    if (idx === -1) return false;
    pos = idx + part.length;
  }
  return pathSeg.length - last.length >= pos;
}

/**
 * Segment-wise glob match — `**` spans any number of segments, `*` stays
 * within one. Hand-rolled (no regex, no dependency) so pattern literals never
 * need escaping.
 */
function globMatches(patternSegs, pathSegs, pi = 0, si = 0) {
  while (pi < patternSegs.length) {
    const seg = patternSegs[pi];
    if (seg === "**") {
      if (pi === patternSegs.length - 1) return true;
      for (let skip = si; skip <= pathSegs.length; skip += 1) {
        if (globMatches(patternSegs, pathSegs, pi + 1, skip)) return true;
      }
      return false;
    }
    if (si >= pathSegs.length) return false;
    if (!segmentMatches(seg, pathSegs[si])) return false;
    pi += 1;
    si += 1;
  }
  return si === pathSegs.length;
}

/** Repo-relative path with forward slashes. */
function rel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Expand MANIFEST-style patterns to concrete files.
 * Returns { files, errors } — a pattern matching nothing is an error, never a
 * silent skip (a renamed directory must not quietly blind the scan).
 */
export function expandManifest(manifest = MANIFEST, root = ROOT) {
  const files = new Set();
  const errors = [];
  for (const pattern of manifest) {
    const magicIndex = pattern.indexOf("*");
    let matched = [];
    if (magicIndex === -1) {
      const full = path.join(root, pattern);
      if (existsSync(full) && statSync(full).isFile()) matched = [pattern];
    } else {
      // Walk from the deepest static directory prefix, then glob-match.
      const staticPrefix = pattern.slice(0, magicIndex);
      const baseDir = path.join(root, staticPrefix.slice(0, staticPrefix.lastIndexOf("/") + 1));
      if (existsSync(baseDir) && statSync(baseDir).isDirectory()) {
        const patternSegs = pattern.split("/");
        matched = walk(baseDir, [])
          .map((f) => rel(root, f))
          .filter((f) => globMatches(patternSegs, f.split("/")));
      }
    }
    if (matched.length === 0) {
      errors.push(`manifest pattern matched no files: ${pattern}`);
    }
    for (const f of matched) files.add(f);
  }
  return { files: [...files].sort(), errors };
}

/**
 * The core detector: every forbidden-literal hit in one file's content, with
 * 1-based line numbers. Exported so the vitest twin can prove the detector
 * detects (a zero-findings run is evidence only if the detector demonstrably
 * fires on seeded content).
 */
export function findLeaksInContent(content, file = "<content>") {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    for (const { literal, brand, ci } of FORBIDDEN) {
      const haystack = ci ? line.toLowerCase() : line;
      const needle = ci ? literal.toLowerCase() : literal;
      if (haystack.includes(needle)) {
        findings.push({ file, line: i + 1, literal, brand });
      }
    }
  }
  return findings;
}

/**
 * Scan every manifest-matched file. Returns { files, findings, errors };
 * clean means files.length > 0, findings empty AND errors empty.
 */
export function scanRepo({ manifest = MANIFEST, root = ROOT } = {}) {
  const { files, errors } = expandManifest(manifest, root);
  if (files.length === 0) {
    errors.push(
      "brand-leak scan matched no files at all — a scan that scanned nothing must fail, not pass",
    );
  }
  const findings = [];
  for (const file of files) {
    const content = readFileSync(path.join(root, file), "utf8");
    findings.push(...findLeaksInContent(content, file));
  }
  return { files, findings, errors };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { files, findings, errors } = scanRepo();
  for (const error of errors) {
    console.error(`brand-leak-scan ERROR: ${error}`);
  }
  for (const f of findings) {
    console.error(
      `brand-leak-scan LEAK: ${f.file}:${f.line} contains "${f.literal}" (brand: ${f.brand}) — brand-resolved files read identity from the brands table, never literals`,
    );
  }
  if (errors.length > 0 || findings.length > 0) {
    console.error(
      `brand-leak-scan: FAILED — ${findings.length} leak(s), ${errors.length} error(s) across ${files.length} file(s).`,
    );
    process.exit(1);
  }
  console.log(
    `brand-leak-scan: OK — ${files.length} file(s) scanned, ${FORBIDDEN.length} literals checked, 0 leaks. (Source half only; the rendered-page half lands with gate 16.)`,
  );
}
