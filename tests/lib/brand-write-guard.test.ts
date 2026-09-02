import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source invariants for the two brand-honesty defects (2026-09-02):
 *
 * 1. A brands-read failure must never be mistaken for single-brand mode by a
 *    WRITE. Every server action that decides a record's brand resolves the
 *    list via `listActiveBrandsForWrite` (refuses on a failed read); the bare
 *    throwing reader and the display-only `listActiveBrandsOrEmpty` are banned
 *    from action files outright, so the next brand-stamping action can't
 *    quietly reintroduce the swallow.
 *
 * 2. The default brand's per-brand card toggle is deliberately dead
 *    (QA-20260826-07 remainder: cardPaymentsAvailable short-circuits it,
 *    cardEnabledBrands seeds it, emailTheme themes Marley regardless) — so the
 *    Settings control must SAY so instead of asserting a state the runtime
 *    ignores.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const BRAND_DECIDING_ACTION_FILES = [
  "app/(dashboard)/leads/actions.ts",
  "app/(dashboard)/clients/actions.ts",
  "app/(dashboard)/schedule/actions.ts",
  "app/(dashboard)/resources/actions.ts",
  "app/(dashboard)/storage/actions.ts",
];

describe("no WRITE decides a brand off a swallowed brands read", () => {
  it.each(BRAND_DECIDING_ACTION_FILES)("%s resolves brands via listActiveBrandsForWrite", (file) => {
    const src = read(file);
    expect(src).toContain("listActiveBrandsForWrite(");
  });

  it("no server-action file anywhere calls the throwing or display readers directly", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "actions.ts" || entry.name.endsWith("-actions.ts")) files.push(full);
      }
    };
    walk(join(ROOT, "app"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // The literal call shapes; prose mentions ("listActiveBrands (data, …)")
      // deliberately don't match.
      expect(src, file).not.toMatch(/listActiveBrands\(/);
      expect(src, file).not.toContain("listActiveBrandsOrEmpty(");
    }
  });

  /**
   * The follow-ups queue is not a write, but it PREFILLS a customer message —
   * a name and a callback number the operator then sends. Built from the
   * ACTIVE list it has two ways to hold no identity for a row that plainly has
   * one (a failed read, or a brand deactivated while its follow-ups were still
   * open), and `lib/comms/templates.ts` answers a missing identity with the
   * default brand's name and office number. So the map comes from the identity
   * reader, which refuses on a failed read and keeps inactive rows.
   */
  it("the follow-ups canned copy resolves its brand map from the identity reader", () => {
    const src = read("app/(dashboard)/follow-ups/page.tsx");
    expect(src).toContain("listBrandIdentities(sb)");
    expect(src).not.toContain("listActiveBrandsOrEmpty(");
    // The map must not be narrowed back to the active subset.
    expect(src).not.toMatch(/brandComms=\{Object\.fromEntries\(activeBrands/);
  });

  it("the brand-deciding form pages fail LOUD rather than rendering picker-less", () => {
    for (const file of ["app/(dashboard)/leads/new/page.tsx", "app/(dashboard)/quotes/new/page.tsx"]) {
      const src = read(file);
      expect(src, file).toContain("listActiveBrands(sb)"); // the throwing reader, on purpose
      expect(src, file).not.toContain("listActiveBrandsOrEmpty("); // prose mentions of it are fine
    }
  });
});

describe("Settings › Brands: the default brand's card toggle tells the truth", () => {
  const src = read("components/settings/brands-card.tsx");

  it("renders the default brand's control disabled, checked, with the truthful caption", () => {
    expect(src).toContain("DEFAULT_BRAND");
    expect(src).toContain("disabled={busy || isDefault}");
    expect(src).toContain("checked={isDefault ? true : cardPayments}");
    expect(src).toContain("follow the global Payments kill switch");
    expect(src).toContain("only applies to other brands");
  });

  it("non-default brands keep the live toggle and its original caption", () => {
    expect(src).toContain("Card on /q and the office payment link");
  });
});
