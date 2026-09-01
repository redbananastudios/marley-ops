import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { FORBIDDEN, MANIFEST, expandManifest, findLeaksInContent, scanRepo } from "../scripts/brand-leak-scan.mjs";

/**
 * Vitest twin of scripts/brand-leak-scan.mjs — the SOURCE half of the
 * brand-leak scan (multi-brand PRD §6 addition 4, §10). Runs the exact same
 * check as the standalone script, so the scan rides `npm test` (vitest's
 * `tests/**` include) with zero package.json change.
 *
 * Evidence discipline: a zero-findings run proves something only if (a) the
 * detector demonstrably fires on seeded content and (b) the manifest
 * demonstrably expanded to real files. Both are asserted here BEFORE the
 * clean-scan assertion, so this file can never deliver the hollow pass the
 * house rules warn about ("a scan that scanned nothing must fail, not pass").
 *
 * NOTE: this file deliberately contains no brand literals of its own — every
 * seeded leak is built from the FORBIDDEN list — so it would itself pass the
 * scan if ever added to the manifest.
 */

describe("brand-leak scan — the detector detects", () => {
  it("flags every forbidden literal when seeded into content", () => {
    for (const entry of FORBIDDEN) {
      const seeded = `const x = "prefix ${entry.literal} suffix";`;
      const findings = findLeaksInContent(seeded, "seeded.ts");
      expect(
        findings.some((f) => f.literal === entry.literal && f.brand === entry.brand),
        `detector must fire on "${entry.literal}"`,
      ).toBe(true);
      expect(findings[0]?.line).toBe(1);
    }
  });

  it("matches case-insensitive entries in any case", () => {
    for (const entry of FORBIDDEN.filter((e) => e.ci)) {
      const findings = findLeaksInContent(entry.literal.toUpperCase(), "seeded.ts");
      expect(
        findings.some((f) => f.literal === entry.literal),
        `ci entry "${entry.literal}" must match its upper-cased form`,
      ).toBe(true);
    }
  });

  it("leaves lowercase brand slugs legal (case-sensitive name entries)", () => {
    // DEFAULT_BRAND, `?brand=` values and data-brand attributes are lowercase
    // slugs — data keys, not display literals. The name entries are
    // case-sensitive precisely so slugs never trip the scan.
    for (const entry of FORBIDDEN.filter((e) => !e.ci)) {
      const lower = entry.literal.toLowerCase();
      expect(lower).not.toBe(entry.literal); // sanity: the entry has case to lose
      const findings = findLeaksInContent(`const slug = "${lower}";`, "seeded.ts");
      expect(
        findings.some((f) => f.literal === entry.literal),
        `lowercase "${lower}" must NOT trip the case-sensitive "${entry.literal}" entry`,
      ).toBe(false);
    }
  });
});

describe("brand-leak scan — the manifest is alive", () => {
  it("expands to at least one real file (a scan of nothing proves nothing)", () => {
    const { files, errors } = expandManifest();
    expect(errors, "no manifest pattern may be dead").toEqual([]);
    expect(files.length).toBeGreaterThan(0);
    // The manifest's founding entry: the shared brand components.
    expect(
      files.some((f) => f.startsWith("components/brand/")),
      "components/brand/** must expand to the shared brand components",
    ).toBe(true);
  });

  it("reports a dead pattern as an error, never a silent skip", () => {
    const { errors } = expandManifest(["components/does-not-exist/**"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("fails an empty scan rather than passing it", () => {
    const { errors, files } = scanRepo({ manifest: [] });
    expect(files).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("expands the gate-11 shared-surface entries to their diary files", () => {
    const { files } = expandManifest();
    for (const f of [
      "components/schedule/scheduler-view.tsx",
      "components/schedule/schedule-allocation-view.tsx",
      "components/schedule/appointment-dialog.tsx",
    ]) {
      expect(files, `${f} must be under scan`).toContain(f);
    }
  });

  it("expands the gate-12 shared-surface entries to the resources + storage files", () => {
    const { files } = expandManifest();
    for (const f of [
      "components/resources/resources-view.tsx",
      "components/job-board/job-board-view.tsx",
      "components/storage/storage-view.tsx",
      "components/storage/manage-let-dialog.tsx",
    ]) {
      expect(files, `${f} must be under scan`).toContain(f);
    }
  });

  it("expands the gate-19 ingest entries to the brand-resolved ingest stack", () => {
    const { files } = expandManifest();
    for (const f of [
      "lib/leads/ingest.ts",
      "app/api/ingest/lead/route.ts",
      "lib/leads/website-lead.ts",
    ]) {
      expect(files, `${f} must be under scan`).toContain(f);
    }
    // The per-brand rails are deliberately NOT scanned (each rail is one
    // brand's own delivery channel — see the manifest comment); assert the
    // exclusion so a future entry is a conscious decision, not drift.
    for (const f of ["lib/sync/wp-leads.ts", "app/api/cron/wp-leads/route.ts"]) {
      expect(files, `${f} is a per-brand rail and must NOT be under scan`).not.toContain(f);
    }
  });
  it("expands the gate-14 entries to the JOB doc-defs, the shared brand module and the call sites", () => {
    const { files } = expandManifest();
    for (const f of [
      "lib/contract-docdef.ts",
      "lib/completion-cert-docdef.ts",
      "lib/job-sheet-docdef.ts",
      "lib/quote/pdf-client.ts",
      "lib/pdf/doc-brand.ts",
      "app/(dashboard)/quotes/[id]/page.tsx",
      "app/api/documents/contract/[signatureId]/route.ts",
      "lib/job-sheet-load.ts",
      "lib/crew-sheet/daily-data.ts",
    ]) {
      expect(files, `${f} must be under scan`).toContain(f);
    }
  });

  it("expands the gate-21 entries to the reporting libs, /performance and the dashboard home", () => {
    const { files } = expandManifest();
    for (const f of [
      "lib/sales-report.ts",
      "lib/storage-report.ts",
      "lib/estimator.ts",
      "components/performance/sales-tab.tsx",
      "components/performance/storage-tab.tsx",
      "app/(dashboard)/performance/page.tsx",
      "lib/dashboard/compute.ts",
      "components/dashboard/dashboard-view.tsx",
      "app/(dashboard)/page.tsx",
    ]) {
      expect(files, `${f} must be under scan`).toContain(f);
    }
  });

  it("keeps the GROUP doc-defs OUT of the manifest — they carry default identity by design (PRD §3.6)", () => {
    // Documents about the GROUP (crew day sheet, contractor statement) render
    // the group identity on purpose; listing them would force allows for
    // literals that are the document's actual content, hollowing the scan.
    const { files } = expandManifest();
    expect(files).not.toContain("lib/crew-sheet/daily-docdef.ts");
    expect(files).not.toContain("lib/staff/statement-docdef.ts");
  });
});

describe("brand-leak scan — shared-surface allows are evidence-disciplined", () => {
  // The gate-11 dialog entry, read from the real manifest so this file still
  // contains no brand literal of its own (see the header note).
  const dialogEntry = MANIFEST.find(
    (e): e is { pattern: string; allow: string[]; reason: string } =>
      typeof e === "object" && e.pattern.endsWith("appointment-dialog.tsx"),
  );

  it("suppresses exactly the allowed literals, nothing else", () => {
    expect(dialogEntry, "the gate-11 dialog entry must exist").toBeDefined();
    const { pattern, allow } = dialogEntry!;
    // Bare entry: the detector demonstrably fires on the real chrome token —
    // a suppression test on a file the detector can't see would be hollow.
    const bare = scanRepo({ manifest: [pattern] });
    expect(bare.errors).toEqual([]);
    for (const literal of allow) {
      expect(
        bare.findings.some((f) => f.literal === literal),
        `bare scan must find "${literal}" in ${pattern} (else the allow below is untested)`,
      ).toBe(true);
    }
    // Shared-surface entry: those hits are suppressed AND nothing else hides
    // behind them — zero findings proves the file is otherwise clean.
    const allowed = scanRepo({ manifest: [{ pattern, allow, reason: "test: the real gate-11 entry, re-stated" }] });
    expect(allowed.errors).toEqual([]);
    expect(allowed.findings).toEqual([]);
  });

  it("reports a dead allow as an error, never a silent no-op", () => {
    // lib/brand-filter.ts is fully brand-resolved — the chrome token never
    // occurs there, so allowing it must ERROR (the exemption is unjustified).
    const literal = dialogEntry!.allow[0];
    const { errors } = scanRepo({
      manifest: [{ pattern: "lib/brand-filter.ts", allow: [literal], reason: "test: unjustified allow" }],
    });
    expect(errors.some((e) => e.includes("dead allow")), "dead allow must be an error").toBe(true);
  });

  it("rejects an allow literal that is not in FORBIDDEN (typo guard)", () => {
    const { errors } = expandManifest([
      { pattern: "lib/brand-filter.ts", allow: ["not-a-forbidden-literal"], reason: "test: typo'd allow" },
    ]);
    expect(errors.some((e) => e.includes("not in FORBIDDEN"))).toBe(true);
  });
});

describe("brand-leak scan — a manifested folder is scanned WHOLE", () => {
  /**
   * The failure this pins (2026-09-01): the five token-route entries were
   * written `app/<seg>/[token]/*.tsx`, which matches one segment ending in
   * .tsx. The sibling server actions in those same folders were therefore
   * never read, and two of them returned a customer-facing error string
   * carrying a forbidden phone number — on a surface every run reported clean.
   *
   * The file's header rule is "a file not listed is NOT clean, it is
   * UNSCANNED", and that rule is sound. The problem is that a folder-shaped
   * pattern READS as covering the folder, so the gap is invisible to a
   * reviewer. This test makes the manifest state its own coverage: if an entry
   * names a directory, every scannable file in that directory must be covered
   * by some entry. Narrowing a pattern then fails here loudly instead of
   * quietly shrinking what "clean" means.
   */
  const SCANNABLE = /\.(ts|tsx|mjs|js|jsx)$/;

  /**
   * Scoped to GLOB entries only. An entry naming one explicit file claims only
   * that file, and several do so deliberately in shared directories like
   * `lib/quote/` where the siblings are not brand surfaces. An entry containing
   * a wildcard is the one that claims a folder — so it is the one that has to
   * cover it.
   */
  it("a glob entry covers every scannable file in the folder it claims", () => {
    const { files } = expandManifest();
    const covered = new Set(files.map((f) => f.replace(/\\/g, "/")));

    const unscanned: string[] = [];
    for (const entry of MANIFEST) {
      // The manifest carries both shapes: a bare pattern string, and an object
      // when the entry needs an `allow` + `reason`.
      const raw: string = typeof entry === "string" ? entry : entry.pattern;
      const pattern: string = raw.replace(/\\/g, "/");
      const segments = pattern.split("/");
      const wildcardAt = segments.findIndex((s) => s.includes("*"));
      if (wildcardAt === -1) continue; // explicit single file — claims only itself
      const dir = segments.slice(0, wildcardAt).join("/");
      const deep = segments.slice(wildcardAt).some((s) => s === "**");

      const walk = (rel: string): void => {
        let listing;
        try {
          listing = readdirSync(join(process.cwd(), rel), { withFileTypes: true });
        } catch {
          return; // a pattern whose directory moved is expandManifest's error to report
        }
        for (const d of listing) {
          const child = `${rel}/${d.name}`;
          if (d.isDirectory()) {
            if (deep) walk(child);
          } else if (SCANNABLE.test(d.name) && !covered.has(child)) {
            unscanned.push(`${child}   (claimed by "${pattern}")`);
          }
        }
      };
      walk(dir);
    }

    expect(
      unscanned,
      `a glob entry names a folder, which READS as covering it — but these files in that folder\n` +
        `are not scanned, so a clean run says nothing about them. That is how two customer-facing\n` +
        `error strings carrying a forbidden phone number sat behind an OK line until 2026-09-01.\n` +
        `Widen the pattern to \`dir/**\`, or add the files explicitly:\n` +
        unscanned.join("\n"),
    ).toEqual([]);
  });
});

describe("brand-leak scan — brand-resolved sources are clean", () => {
  it("finds zero forbidden literals across the manifest", () => {
    const { files, findings, errors } = scanRepo();
    expect(errors).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
    const report = findings
      .map((f) => `${f.file}:${f.line} contains "${f.literal}" (brand: ${f.brand})`)
      .join("\n");
    expect(
      findings,
      `brand-resolved files must read identity from the brands table, never literals:\n${report}`,
    ).toEqual([]);
  });
});
