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
 * SHARED-SURFACE ENTRIES: some brand-resolved files are shared surfaces —
 * both brands' records render through them — that deliberately keep Marley
 * APP CHROME (PRD §2 "App chrome — unchanged": the mm-red toolbar, today
 * ring, now-indicator and control tints belong to the frame, not the
 * records). A blanket literal ban would flag chrome the PRD mandates, so a
 * manifest entry may be `{ pattern, allow, reason }`: the named literals are
 * exempt IN THAT ENTRY'S FILES ONLY, everything else stays forbidden both
 * directions. The exemption is evidence-disciplined, mirroring the
 * dead-pattern rule: an allow literal that is not in FORBIDDEN is an ERROR
 * (a typo would otherwise suppress nothing, silently, forever), and an allow
 * literal that no longer occurs under its pattern is an ERROR — so fixing
 * the underlying literal forces the allow's removal in the same change, and
 * an exemption can never outlive its justification.
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
 * An entry is either a bare pattern string or a shared-surface object
 * `{ pattern, allow, reason }` — see SHARED-SURFACE ENTRIES above.
 */
export const MANIFEST = [
  "components/brand/**",
  "lib/brand-filter.ts",
  // Gate 5: the lead page's change-brand control — fully data-driven (names
  // and colours arrive as brands-table rows via props).
  "app/(dashboard)/leads/[id]/brand-changer.tsx",
  // Gate 11: the diary surfaces. Event styling is brand-resolved (styleFor()
  // over the slim brands prop; the brand picker and chips are data-driven),
  // but each keeps deliberate mm-red APP CHROME per PRD §2, plus comments
  // naming brands to document the parity contract — hence the allows.
  // Domains, phone numbers, Connor and mailboxes stay forbidden here, as
  // does every literal not named in `allow`.
  {
    pattern: "components/schedule/scheduler-view.tsx",
    allow: ["mm-red", "Marley", "Pitmans"],
    reason:
      "mm-red toolbar/today-ring/now-indicator/FAB app chrome (PRD §2); Marley + Pitmans appear only in comments documenting the parity contract and the accent-colour data rule",
  },
  {
    pattern: "components/schedule/schedule-allocation-view.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red tab/board/day-strip app chrome (PRD §2). (The soft-demand copy's hardcoded 'Marley' was the §10 leak this gate fixed — now brand-neutral, so no 'Marley' allow.)",
  },
  {
    pattern: "components/schedule/appointment-dialog.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): icon tints, required-field marker, radio accent, destructive-action button",
  },
  // Gate 11 residual: the client-record "Book survey" flows. Their brand
  // picker is data-driven (slim brands-table rows via props); only deliberate
  // mm-red APP CHROME remains per PRD §2 — everything else stays forbidden
  // both directions.
  {
    pattern: "components/clients/book-survey-button.tsx",
    allow: ["mm-red"],
    reason: "mm-red app chrome (PRD §2): the Book survey button fill and the required-field marker",
  },
  {
    pattern: "components/clients/add-client-dialog.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): checkbox accent, required-field markers, address section tint",
  },
  // Gate 12: resources + storage. The vehicle livery chip and Livery select,
  // the job-board livery-mismatch note, storage site/let chips, the brand
  // filter and the site/let/manage dialogs' brand selects are all data-driven
  // (slim brands-table rows via props); only deliberate mm-red APP CHROME
  // remains per PRD §2 — everything else stays forbidden both directions.
  // (app/(dashboard)/storage/actions.ts is deliberately NOT listed: its
  // agreement email still hardcodes default-brand identity — that is gate 13
  // comms work, and listing the file before then would just be a red scan.)
  {
    pattern: "components/resources/resources-view.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): active-toggle fill, working-days selected state, dialog save buttons",
  },
  {
    pattern: "components/job-board/job-board-view.tsx",
    allow: ["mm-red", "Marley"],
    reason:
      "mm-red app chrome (PRD §2): today-column highlight, surveys toggle, assign-modal selection states, save buttons and the vehicle icon-tile tint; Marley appears only in the comment naming that tile tint — the livery-mismatch note itself is data-driven",
  },
  {
    pattern: "components/storage/storage-view.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): occupancy pill and segmented occupancy filter, selected-site/unit accents, checkbox accents, action/save buttons",
  },
  {
    pattern: "components/storage/manage-let-dialog.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): sign-here checkbox accent and the sign/save/add action buttons",
  },
  // Gate 19: the ingest stack. These three are brand-resolved by contract —
  // one route serves EVERY brand's website, the pure half derives the brand
  // from whichever secret matched (never the payload, PRD §3.8), and the
  // landing path takes brand as data — so they live under scan. The default
  // brand's name (and, in ingest.ts, its domain) appears only in comments
  // pinning the pre-brand-layer compatibility contract: the live site posts
  // with the original `LEAD_INGEST_SECRET` and must see zero change.
  //
  // Deliberately NOT listed, because they are PER-BRAND RAILS by design, not
  // leak surfaces (each rail is one brand's own delivery channel and may name
  // its brand, exactly as lib/sync/sanity-leads.ts — the default brand's pull
  // rail — has never been listed): lib/sync/wp-leads.ts and
  // app/api/cron/wp-leads/route.ts (the second brand's pull rail), and the
  // WordPress plugin under wordpress/pitmans-lead-bridge/ (PHP shipped to that
  // brand's own site; a "leak" of its brand into it is the point).
  {
    pattern: "lib/leads/ingest.ts",
    allow: ["Marley", "marleymoves.co.uk"],
    reason:
      "comments only: the compatibility contract for the pre-brand-layer LEAD_INGEST_SECRET names whose secret it is and which live site posts with it",
  },
  {
    pattern: "app/api/ingest/lead/route.ts",
    allow: ["Marley"],
    reason:
      "comment only: the route contract doc names whose secret LEAD_INGEST_SECRET is and stays",
  },
  {
    pattern: "lib/leads/website-lead.ts",
    allow: ["Marley"],
    reason:
      "comments only: the brand-field doc and the sanity_id-stays-global rationale name which brand's pull rail carries a Sanity id",
  },
  // Gate 14: the JOB-document doc-defs (PRD §3.6). Brand identity, colours and
  // filenames arrive as a DocBrand from the brands row; the remaining default-
  // brand literals are the DEFAULT CONSTANTS selected when no brand is passed —
  // the byte-parity contract, so they are allowed, not leaks. (The GROUP
  // doc-defs — lib/crew-sheet/daily-docdef.ts, lib/staff/statement-docdef.ts —
  // are deliberately NOT listed: they carry group/default identity by design
  // and take no brand parameter.)
  {
    pattern: "lib/contract-docdef.ts",
    allow: ["Marley"],
    reason:
      "default-brand constants (byte-parity, PRD §3.6): the wordmark fallback and the in-person device line's default",
  },
  {
    pattern: "lib/completion-cert-docdef.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070"],
    reason:
      "default-brand constants (byte-parity, PRD §3.6): wordmark, declaration and footer identity fallbacks",
  },
  {
    pattern: "lib/job-sheet-docdef.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070"],
    reason:
      "default-brand constants (byte-parity, PRD §3.6): wordmark and footer fallbacks; 'Marley Ops' in the video-QR copy is the app name — app chrome per PRD §2",
  },
  {
    pattern: "lib/quote/pdf-client.ts",
    allow: ["Marley", "marleymoves.co.uk", "01747 637070", "Pitmans"],
    reason:
      "default-brand constants (byte-parity, PRD §3.6): the MarleyMoves filename shape, contact rows, footer legal line, pdf info block and the shared bank card (PRD §2 — one account for every brand); Marley elsewhere + Pitmans appear only in comments documenting the §10 filename shape and the WCAG accent pick",
  },
  {
    pattern: "lib/pdf/doc-brand.ts",
    allow: ["Marley"],
    reason:
      "appears only in a comment documenting the tint data rule the default-brand doc-defs hardcode — the module itself carries no identity, colour fallback #C03838 is the documented brandCtaColour degrade",
  },
  // Gate 14 call sites and PDF-triggering components: brand resolution happens
  // where a supabase client exists (getBrandOrDefault → docBrandFrom), then
  // travels as a plain DocBrand. The quote/crew UI keeps deliberate mm-red APP
  // CHROME (PRD §2 — the frame, not the records); remaining name hits are
  // jsdoc/comments documenting the byte-parity contract. Files with no
  // forbidden literal at all ride as bare entries so a later edit can never
  // quietly re-hardcode identity into a branded surface.
  "app/api/documents/contract/[signatureId]/route.ts",
  "components/job-sheet-button.tsx",
  "lib/crew-sheet/daily-data.ts",
  {
    pattern: "app/(dashboard)/quotes/[id]/page.tsx",
    allow: ["Marley"],
    reason:
      "appears only in the comment documenting that getBrandOrDefault's bad-slug fallback lands on the default-brand parity rail",
  },
  {
    pattern: "components/quote/quote-builder.tsx",
    allow: ["Marley", "mm-red"],
    reason:
      "mm-red app chrome (PRD §2): CTA buttons and wizard step dots; Marley appears only in the header comment and the brand-prop jsdoc documenting the parity contract",
  },
  {
    pattern: "components/quote/quote-header-actions.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): the send button. The gate-14 'Marley' allow is GONE — gate 13 rewrote the brand-prop jsdoc to describe the full brands row, so the literal no longer occurs and the dead-allow rule required its removal",
  },
  {
    pattern: "components/quote/resend-quote-button.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): the mail icon tint. The gate-14 'Marley' allow is GONE for the same reason as quote-header-actions.tsx above",
  },
  {
    pattern: "app/my-jobs/[id]/page.tsx",
    allow: ["mm-red"],
    reason: "mm-red app chrome (PRD §2): the removal type chip and the sticky action button",
  },
  {
    pattern: "components/crew/complete-job-button.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): trigger/submit buttons and the confirmation checkbox accent",
  },
  {
    pattern: "lib/job-sheet-load.ts",
    allow: ["Marley", "marleymoves.co.uk"],
    reason:
      "ops.marleymoves.co.uk is the APP's own origin (NEXT_PUBLIC_APP_URL fallback for the crew job link — one app hosts every brand, app chrome per PRD §2, not document identity); Marley appears only in the legacy-iMVE contract comment",
  },
  // Gate 21: the /performance reporting surface. The report libs slice by a
  // brand PARAMETER (rows carry the slug as data, never a literal); the page's
  // segmented filter, tab links, chips and Brand column are all data-driven
  // from brands-table rows.
  "lib/sales-report.ts",
  "lib/storage-report.ts",
  "lib/estimator.ts",
  "components/performance/sales-tab.tsx",
  {
    pattern: "components/performance/storage-tab.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red occupancy-bar fill (PRD §4 /storage: occupancy is a physical fact, not a brand one — app chrome per §2)",
  },
  {
    pattern: "app/(dashboard)/performance/page.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red lost-reasons meter fill — report chart chrome (PRD §2), not a brand record",
  },
  // Gate 21 continued: the dashboard home. The KPI brand sub-lines, splits
  // and the section filter are all data-driven (buildBrandKpiSplits over
  // brands-table slugs; BrandChip/BrandFilter take slim brands rows via
  // props); only deliberate mm-red APP CHROME and one legacy-business-rule
  // comment remain — everything else stays forbidden both directions.
  "lib/dashboard/compute.ts",
  {
    pattern: "components/dashboard/dashboard-view.tsx",
    allow: ["mm-red"],
    reason:
      "mm-red app chrome (PRD §2): view-all/deep-dive links, KPI accent tiles, decline arrow and drop-percentage tints, stat accents",
  },
  {
    pattern: "app/(dashboard)/page.tsx",
    allow: ["Marley"],
    reason:
      "appears only in the legacy-iMVE contract-suppression comment (same rule lib/job-sheet-load.ts documents) — the unsigned-contracts tile logic, not rendered identity",
  },
  // STILL-NOT-manifest, and this note is deliberately NOT self-clearing.
  //
  // Written before gate 13 as "add both entries in gate 13's PR instead". Gate
  // 13 has now landed and they are still absent, because the reason they were
  // excluded has NOT gone away: both files retain default-brand identity that
  // an allow list would have to exempt wholesale, which is exactly the masking
  // the original note warned against.
  //
  //   components/quote/send-quote-dialog.tsx — the subject line's default arm
  //     is the "Marley Moves" literal (brand.slug !== "marley" ? brand.name :
  //     "Marley Moves"), plus the "MarleyMoves-Quote-<ref>.pdf" filename echo.
  //     Exempting those needs allow: ["Marley Moves", "MarleyMoves", ...],
  //     which would also wave through a genuine leak of either literal.
  //   app/actions/crew-signatures.ts — two marleymoves.co.uk office-notification
  //     links survive brand resolution.
  //
  // So these two remain unscanned, and that gap is stated here rather than
  // being hidden behind a green run (this file's own evidence-discipline rule:
  // "I could not check" must never render as "nothing to report"). Whoever
  // de-brands those surfaces adds the entries in the SAME change and deletes
  // this block — do not add them earlier to make the manifest look complete.

  // Gate 16: the customer accept page. Identity now comes entirely from
  // `pageTheme` — logo, name, phone, terms link, legal line, the accent (one
  // CSS-variable override on the shell, so the mm-red utility CLASSES below
  // are re-pointed rather than replaced) and whether card is mentioned at all.
  //
  // The mm-red allow is therefore not chrome in the §2 sense: these are record
  // surfaces whose token is re-pointed per brand at runtime, which a source
  // grep cannot see. That is exactly the gap the RENDERED half of this scan
  // exists to close, and it is why the class names stay — replacing them with
  // inline styles would lose every `hover:`/`focus:` accent variant.
  //
  // Domains, phone numbers, mailboxes and Connor stay forbidden here, and the
  // page carries none of them any more.
  {
    pattern: "app/q/[token]/*.tsx",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the shell (gate 16); no hardcoded name, phone, domain or named individual remains",
  },
  // Gate 16, the remaining token pages. Same mechanism throughout: identity
  // from `pageTheme`, accent from one CSS-variable override on the page root.
  //
  // /s and /cv are RECORD surfaces — they take the brand of the let and the
  // lead respectively. /sheet and /join are GROUP surfaces (PRD §4): one
  // shared crew across every brand, so they take `GROUP_PAGE_THEME`, whose
  // accent is neutral charcoal rather than either brand's colour.
  {
    pattern: "app/s/[token]/*.tsx",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the page root (gate 16); the storage-agreement identity, terms link and phone are all theme-resolved",
  },
  {
    pattern: "app/cv/[token]/*.tsx",
    allow: ["mm-red"],
    reason:
      "accent utility classes re-pointed per brand via --color-mm-red on the page root (gate 16); CubicBuilder is shared with the office builder, which renders outside this element and is unaffected",
  },
  {
    pattern: "app/sheet/[token]/*.tsx",
    allow: ["mm-red"],
    reason:
      "group surface (PRD §4): the mm-red utilities are re-pointed to neutral charcoal by GROUP_PAGE_THEME, so a mixed-brand crew day is coloured as neither brand",
  },
  {
    pattern: "app/join/[token]/*.tsx",
    allow: ["mm-red"],
    reason:
      "group surface (PRD §4): one shared crew, so the copy names no brand and the accent is neutralised by GROUP_PAGE_THEME",
  },
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
 * Returns { files, errors, entries } — `files` is the deduplicated union,
 * `entries` keeps the per-entry breakdown ({ pattern, allow, files }) so
 * shared-surface allows can be checked against exactly the files they cover.
 * A pattern matching nothing is an error, never a silent skip (a renamed
 * directory must not quietly blind the scan); an allow literal that is not
 * in FORBIDDEN is an error too (a typo must not suppress nothing, silently).
 */
export function expandManifest(manifest = MANIFEST, root = ROOT) {
  const files = new Set();
  const errors = [];
  const entries = [];
  const knownLiterals = new Set(FORBIDDEN.map((f) => f.literal));
  for (const entry of manifest) {
    const pattern = typeof entry === "string" ? entry : entry.pattern;
    const allow = typeof entry === "string" ? [] : (entry.allow ?? []);
    for (const literal of allow) {
      if (!knownLiterals.has(literal)) {
        errors.push(
          `allow literal is not in FORBIDDEN (typo? exact case matters): "${literal}" under ${pattern}`,
        );
      }
    }
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
    entries.push({ pattern, allow, files: matched });
  }
  return { files: [...files].sort(), errors, entries };
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
 * clean means files.length > 0, findings empty AND errors empty. Findings
 * for a shared-surface entry's allowed literals are suppressed — but a dead
 * allow (a literal with zero suppressed hits under its own pattern) is an
 * ERROR, so the exemption disappears in the same change as the literal.
 */
export function scanRepo({ manifest = MANIFEST, root = ROOT } = {}) {
  const { files, errors, entries } = expandManifest(manifest, root);
  if (files.length === 0) {
    errors.push(
      "brand-leak scan matched no files at all — a scan that scanned nothing must fail, not pass",
    );
  }
  const allowByFile = new Map();
  for (const { allow, files: entryFiles } of entries) {
    for (const f of entryFiles) {
      if (allow.length === 0) continue;
      const set = allowByFile.get(f) ?? new Set();
      for (const literal of allow) set.add(literal);
      allowByFile.set(f, set);
    }
  }
  const findings = [];
  const rawByFile = new Map();
  for (const file of files) {
    const content = readFileSync(path.join(root, file), "utf8");
    const raw = findLeaksInContent(content, file);
    rawByFile.set(file, raw);
    const allowed = allowByFile.get(file);
    findings.push(...(allowed ? raw.filter((f) => !allowed.has(f.literal)) : raw));
  }
  for (const { pattern, allow, files: entryFiles } of entries) {
    for (const literal of allow) {
      const occurs = entryFiles.some((f) =>
        (rawByFile.get(f) ?? []).some((hit) => hit.literal === literal),
      );
      if (!occurs) {
        errors.push(
          `dead allow: "${literal}" never occurs under ${pattern} — the exemption has outlived its justification, remove it`,
        );
      }
    }
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
