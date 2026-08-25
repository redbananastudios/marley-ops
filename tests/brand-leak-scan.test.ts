import { describe, expect, it } from "vitest";
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
