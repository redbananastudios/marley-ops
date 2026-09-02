import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST, expandManifest, scanRepo } from "../../scripts/brand-leak-scan.mjs";

/**
 * Coverage guard for the two directories the source scan certifies but could
 * not see: `lib/comms/` and the storage-agreement sender.
 *
 * PRD §10 names `lib/comms/` FIRST among the paths the source grep covers, and
 * §3.5 makes the email builders the highest-risk surface in the project — a
 * leak there reaches a customer's inbox under another brand's sign-off. Until
 * 2026-09-02 the manifest expanded to ZERO files beneath it, so every run
 * printed "OK — N files scanned, 0 leaks" while never opening one of them. The
 * scan's own header rule ("a file not listed is NOT clean — it is UNSCANNED")
 * was sound but invisible: the reader had no way to tell which side of it
 * `lib/comms/` fell on.
 *
 * So this file makes the manifest state its own comms coverage. Every
 * scannable file under `lib/comms/` must be EITHER under scan OR named
 * verbatim in the script's own exclusion note — there is no third state where
 * a file is silently absent. Adding a comms module therefore forces a
 * deliberate decision in the same change, which is the mechanical form of the
 * house rule that "I could not check" must never render as "nothing to
 * report".
 *
 * NOTE: like its sibling tests/brand-leak-scan.test.ts, this file deliberately
 * contains no brand literals of its own — every literal it reasons about is
 * read back out of MANIFEST — so it would itself pass the scan if ever listed.
 */

const SCAN_SOURCE = "scripts/brand-leak-scan.mjs";
const COMMS_DIR = "lib/comms";
const SCANNABLE = /\.(ts|tsx|mjs|js|jsx)$/;

/** The customer-facing email builders — the §3.5 surfaces a leak reaches an
 *  inbox through. Named explicitly rather than derived, so removing one from
 *  the manifest is a failing test rather than a quietly smaller "every file is
 *  accounted for" set. */
const CUSTOMER_EMAIL_BUILDERS = [
  "lib/comms/brand-theme.ts",
  "lib/comms/cancellation-emails.ts",
  "lib/comms/commitment-chase-email.ts",
  "lib/comms/completion-email.ts",
  "lib/comms/date-confirm-email.ts",
  "lib/comms/payment-email.ts",
  "lib/comms/quote-email.ts",
  "lib/comms/refund-emails.ts",
  "lib/comms/review-request.ts",
  "lib/comms/storage-invoice-email.ts",
  "lib/comms/templates.ts",
];

describe("brand-leak scan — the comms tree is covered, not assumed", () => {
  it("puts every customer-facing email builder under scan", () => {
    const { files } = expandManifest();
    for (const f of CUSTOMER_EMAIL_BUILDERS) {
      expect(files, `${f} builds customer email and must be under scan (PRD §3.5/§10)`).toContain(f);
    }
  });

  it("accounts for every file under lib/comms — scanned, or named as excluded", () => {
    const { files } = expandManifest();
    const covered = new Set(files);
    const source = readFileSync(join(process.cwd(), SCAN_SOURCE), "utf8");

    const unaccounted = readdirSync(join(process.cwd(), COMMS_DIR))
      .filter((name) => SCANNABLE.test(name))
      .map((name) => `${COMMS_DIR}/${name}`)
      .filter((f) => !covered.has(f) && !source.includes(f));

    expect(
      unaccounted,
      `PRD §10 names ${COMMS_DIR}/ first among the source-grep paths, and §3.5 makes it the\n` +
        `highest-risk tree in the project. These files are neither scanned nor named in the\n` +
        `exclusion note in ${SCAN_SOURCE}, so a clean run says nothing about them and the\n` +
        `reader cannot tell. Add each to MANIFEST, or name it in the exclusion note with the\n` +
        `reason it stays out:\n` +
        unaccounted.join("\n"),
    ).toEqual([]);
  });

  it("puts the storage-agreement sender under scan (its gate-13 exclusion has expired)", () => {
    // The agreement email resolves the LET's brand and sends from that brand's
    // front door, so it is a brand-resolved surface like any other builder —
    // the manifest excluded it while that conversion was still pending, and the
    // note outlived the work.
    const { files } = expandManifest();
    expect(files).toContain("app/(dashboard)/storage/actions.ts");
  });
});

describe("brand-leak scan — the widened entries are honestly allowed", () => {
  /** Every manifest entry that reaches into the comms tree or the storage
   *  sender, read back from MANIFEST so this file names no literal itself. */
  const widened = MANIFEST.map((entry) =>
    typeof entry === "string" ? { pattern: entry, allow: [] as string[] } : entry,
  ).filter((e) => e.pattern.startsWith(COMMS_DIR) || e.pattern.endsWith("storage/actions.ts"));

  it("scans each of them clean, with no dead allow hiding behind the entry", () => {
    expect(widened.length, "the widened entries must exist to be checked").toBeGreaterThan(0);
    for (const { pattern, allow } of widened) {
      // scanRepo reports a dead allow as an ERROR, so an entry that is green
      // here is green because its literals occur and are justified — not
      // because a stale exemption swallowed the file whole.
      const { files, findings, errors } = scanRepo({
        manifest: [allow.length ? { pattern, allow, reason: "test: the real entry, re-stated" } : pattern],
      });
      expect(files.length, `${pattern} must expand to a real file`).toBeGreaterThan(0);
      expect(errors, `${pattern} carries a dead or typo'd allow`).toEqual([]);
      expect(
        findings.map((f) => `${f.file}:${f.line} "${f.literal}"`),
        `${pattern} leaks a literal its allow list does not cover`,
      ).toEqual([]);
    }
  });
});
