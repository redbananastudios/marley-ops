import { describe, expect, it } from "vitest";

import { brandFromReference } from "../../../scripts/ledger-snapshot.mjs";

/**
 * Vitest twin of the archive's brand attribution (design §9, §11), following the
 * `tests/brand-leak-scan.test.ts` precedent of importing the .mjs directly so
 * the script and the test can never drift.
 *
 * The property under test is not "does it label things" — it is **does it refuse
 * to label the things it cannot know**. A wrong brand here is invisible: the
 * archive renders, the number looks plausible, and nobody can tell that a
 * Pitmans storage invoice was counted as Marley revenue.
 */

// Mirrors what the script reads from `brands.ref_prefix`.
const PREFIXES = new Map<string, string>([
  ["MM", "marley"],
  ["PM", "pitmans"],
]);

const brand = (ref: string | null | undefined) => brandFromReference(ref, PREFIXES);

describe("current-scheme references", () => {
  it("attributes the removal and commercial refs seen in the live Xero list", () => {
    expect(brand("MMR102-DEP")).toBe("marley");
    expect(brand("MMR102-COM")).toBe("marley");
    expect(brand("MMR079-BAL")).toBe("marley");
    expect(brand("MMC002-COM")).toBe("marley");
  });

  it("attributes Pitmans refs to Pitmans", () => {
    expect(brand("PMR001-DEP")).toBe("pitmans");
    expect(brand("PMC014-BAL")).toBe("pitmans");
  });

  it("is case-insensitive — office and bank feeds both mangle case", () => {
    expect(brand("mmr102-dep")).toBe("marley");
    expect(brand("PmR001")).toBe("pitmans");
  });

  it("accepts refs with more than three digits (the counter is not capped at 999)", () => {
    expect(brand("MMR10245-BAL")).toBe("marley");
  });
});

describe("legacy-scheme references", () => {
  /**
   * design §11 corrected §9 here: `lib/bank-feed/match.ts` carries a SECOND
   * pattern, `MM-\d{6}-\d{3}`, and the legacy form does carry its brand pair.
   * Matching only the current scheme would dump every pre-rename invoice into
   * the unattributed bucket for no reason.
   */
  it("attributes MM-YYMMDD-NNN, which is live in the migrated Xero data", () => {
    expect(brand("MM-260709-308-BAL")).toBe("marley");
    expect(brand("MM-260709-308")).toBe("marley");
  });
});

describe("refusing to guess", () => {
  /**
   * THE trap. Storage references are `MMS-<hash>`, minted with no brand input at
   * all (lib/storage-billing.ts). A `startsWith(ref_prefix)` compare would
   * attribute every storage invoice — Pitmans lets included — to Marley, and the
   * output would look entirely correct.
   */
  it("leaves storage references unattributed rather than reading MMS- as Marley", () => {
    expect(brand("MMS-a1b2c3d4")).toBeNull();
    expect(brand("MMS-ZZZZZZ")).toBeNull();
  });

  it("leaves iMovE import references unattributed", () => {
    expect(brand("IMV007-BAL")).toBeNull();
    expect(brand("IMV008-BAL")).toBeNull();
  });

  it("returns null for empty, missing and junk references", () => {
    expect(brand("")).toBeNull();
    expect(brand(null)).toBeNull();
    expect(brand(undefined)).toBeNull();
    expect(brand("cheque from mum")).toBeNull();
  });

  /**
   * Word-boundary guard. Without `\b` the "MMR123" inside a longer token would
   * match and silently attribute an unrelated reference.
   */
  it("does not match a brand pair buried inside another token", () => {
    expect(brand("COMMR123")).toBeNull();
    expect(brand("XPMR001")).toBeNull();
  });

  /**
   * A prefix the brands table does not know is NOT a licence to invent a brand.
   * This is what protects the archive when brand 3 lands: unknown yields null,
   * which is visible, rather than the nearest match, which is not.
   */
  it("returns null for a well-formed ref whose prefix is not in the brands table", () => {
    const onlyMarley = new Map<string, string>([["MM", "marley"]]);
    expect(brandFromReference("PMR001-DEP", onlyMarley)).toBeNull();
  });

  it("returns null when the brands table has no prefixes at all", () => {
    expect(brandFromReference("MMR102-DEP", new Map())).toBeNull();
  });
});
