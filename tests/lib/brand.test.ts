import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_BRAND,
  GROUP_BRAND,
  getBrand,
  getBrandOrDefault,
  isMultiBrand,
  listActiveBrands,
  listActiveBrandsForWrite,
  listActiveBrandsOrEmpty,
  listBrandIdentities,
  mapBrand,
} from "@/lib/brand";

/** Minimal read-only stub: whatever rows the query "returns" — the filter chain
 *  itself is the DB's job, so tests hand it pre-filtered rows and assert the
 *  pure mapping + length logic on top. */
function sbReturning(rows: Record<string, unknown>[]): SupabaseClient {
  const result = Promise.resolve({ data: rows, error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    order: () => result,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

/** The stub for the defect under test: the brands QUERY ERRORS — which must
 *  never be indistinguishable from the legitimate empty list (single-brand
 *  mode), because every `length > 1` gate downstream would silently collapse
 *  to single-brand behaviour mid-failure. */
function sbFailing(message: string): SupabaseClient {
  const result = Promise.resolve({ data: null, error: { message } });
  const chain = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    order: () => result,
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("mapBrand", () => {
  it("maps a full snake_case row to camelCase", () => {
    expect(
      mapBrand({
        slug: "marley",
        name: "Marley Moves",
        short_name: "Marley",
        initial: "M",
        group_line: "Part of the Marley Group",
        legal_line: "MarleyMoves Ltd · Company No. 15914266 · VAT 520 2213 58",
        ref_prefix: "MM",
        colour_primary: "#1A1A1A",
        colour_accent: "#C03838",
        logo_url: "https://marleymoves.co.uk/logo.png",
        email_domain: "marleymoves.co.uk",
        hello_from: "hello@marleymoves.co.uk",
        accounts_from: "accounts@marleymoves.co.uk",
        reply_domain: "reply.marleymoves.co.uk",
        phone: "01747 637070",
        terms_url: "https://marleymoves.co.uk/terms-conditions/",
        card_payments_enabled: true,
        resend_template_ids: { deposit_request: "tpl_123" },
        active: true,
        sort_order: 0,
      }),
    ).toMatchObject({
      slug: "marley",
      name: "Marley Moves",
      shortName: "Marley",
      initial: "M",
      groupLine: "Part of the Marley Group",
      legalLine: "MarleyMoves Ltd · Company No. 15914266 · VAT 520 2213 58",
      refPrefix: "MM",
      colourPrimary: "#1A1A1A",
      colourAccent: "#C03838",
      logoUrl: "https://marleymoves.co.uk/logo.png",
      emailDomain: "marleymoves.co.uk",
      helloFrom: "hello@marleymoves.co.uk",
      accountsFrom: "accounts@marleymoves.co.uk",
      replyDomain: "reply.marleymoves.co.uk",
      phone: "01747 637070",
      termsUrl: "https://marleymoves.co.uk/terms-conditions/",
      cardPaymentsEnabled: true,
      resendTemplateIds: { deposit_request: "tpl_123" },
      active: true,
      sortOrder: 0,
    });
  });

  it("defaults every optional field on a minimal row (the Pitmans Phase 0 shape)", () => {
    const brand = mapBrand({
      slug: "pitmans",
      name: "Pitmans Removals & Storage",
      short_name: "Pitmans",
      group_line: "Part of the Marley Group",
      legal_line: "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd.",
    });
    expect(brand).toMatchObject({
      slug: "pitmans",
      initial: null,
      refPrefix: null,
      logoUrl: null,
      reviewUrl: null,
      termsUrl: null,
      smsSender: null,
      baseLocation: null,
      ledgerBrandingId: null,
      cardPaymentsEnabled: false, // safe default — card copy must never appear by accident
      resendTemplateIds: {},
      active: true,
      sortOrder: 0,
    });
  });

  it("keeps only string-valued template ids and never trusts junk shapes", () => {
    expect(
      mapBrand({
        slug: "marley",
        name: "Marley Moves",
        short_name: "Marley",
        group_line: "",
        legal_line: "",
        resend_template_ids: { good: "tpl_1", bad: 42, worse: null },
      }).resendTemplateIds,
    ).toEqual({ good: "tpl_1" });
    expect(
      mapBrand({
        slug: "marley",
        name: "Marley Moves",
        short_name: "Marley",
        group_line: "",
        legal_line: "",
        resend_template_ids: ["not", "an", "object"],
      }).resendTemplateIds,
    ).toEqual({});
  });

  it("treats blank strings as null for nullable fields", () => {
    const brand = mapBrand({
      slug: "group",
      name: "Marley Group",
      short_name: "Group",
      group_line: "",
      legal_line: "MarleyMoves Ltd · Company No. 15914266 · VAT 520 2213 58",
      ref_prefix: "  ",
      phone: "",
    });
    expect(brand.refPrefix).toBeNull();
    expect(brand.phone).toBeNull();
    expect(brand.groupLine).toBe(""); // required fields keep the empty string
  });
});

describe("isMultiBrand — the single-brand invariant switch", () => {
  const marley = {
    slug: DEFAULT_BRAND,
    name: "Marley Moves",
    short_name: "Marley",
    group_line: "Part of the Marley Group",
    legal_line: "MarleyMoves Ltd",
    active: true,
    sort_order: 0,
  };
  const pitmans = {
    slug: "pitmans",
    name: "Pitmans Removals & Storage",
    short_name: "Pitmans",
    group_line: "Part of the Marley Group",
    legal_line: "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd.",
    active: true,
    sort_order: 1,
  };

  it("is false with a single active brand — today's UI must not change", async () => {
    expect(await isMultiBrand(sbReturning([marley]))).toBe(false);
  });

  it("is false with no rows at all (unmigrated database)", async () => {
    expect(await isMultiBrand(sbReturning([]))).toBe(false);
  });

  it("flips true the moment a second brand is active", async () => {
    expect(await isMultiBrand(sbReturning([marley, pitmans]))).toBe(true);
  });

  it("listActiveBrands maps rows and never includes the group pseudo-brand slug in its output type", async () => {
    const brands = await listActiveBrands(sbReturning([marley, pitmans]));
    expect(brands.map((b) => b.slug)).toEqual([DEFAULT_BRAND, "pitmans"]);
    expect(brands[1]).toMatchObject({ shortName: "Pitmans", cardPaymentsEnabled: false });
    // the group exclusion itself is a DB-side .neq(slug, GROUP_BRAND) filter;
    // assert the constant it filters on so a rename can't silently widen it.
    expect(GROUP_BRAND).toBe("group");
  });
});

describe("a brands READ FAILURE is never mistaken for single-brand mode", () => {
  const marley = {
    slug: DEFAULT_BRAND,
    name: "Marley Moves",
    short_name: "Marley",
    group_line: "Part of the Marley Group",
    legal_line: "MarleyMoves Ltd",
    active: true,
    sort_order: 0,
  };
  const pitmans = {
    slug: "pitmans",
    name: "Pitmans Removals & Storage",
    short_name: "Pitmans",
    group_line: "Part of the Marley Group",
    legal_line: "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd.",
    active: true,
    sort_order: 1,
  };

  it("listActiveBrands THROWS on a query error — [] is reserved for the real empty table", async () => {
    await expect(listActiveBrands(sbFailing("connection reset"))).rejects.toThrow(
      /brands read failed: connection reset/,
    );
  });

  it("isMultiBrand propagates the failure rather than reporting single-brand mode", async () => {
    await expect(isMultiBrand(sbFailing("boom"))).rejects.toThrow(/brands read failed/);
  });

  it("listActiveBrandsOrEmpty is the EXPLICIT display-only degrade: [] on failure, rows otherwise", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await listActiveBrandsOrEmpty(sbFailing("boom"))).toEqual([]);
      expect(spy).toHaveBeenCalled(); // degraded, but never silently
    } finally {
      spy.mockRestore();
    }
    const brands = await listActiveBrandsOrEmpty(sbReturning([marley, pitmans]));
    expect(brands.map((b) => b.slug)).toEqual([DEFAULT_BRAND, "pitmans"]);
  });

  it("listActiveBrandsForWrite refuses on failure so no write can decide a brand off it", async () => {
    const res = await listActiveBrandsForWrite(sbFailing("boom"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nothing was saved/i);
  });

  it("listActiveBrandsForWrite hands the mapped rows through on success", async () => {
    const res = await listActiveBrandsForWrite(sbReturning([marley, pitmans]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.brands.map((b) => b.slug)).toEqual([DEFAULT_BRAND, "pitmans"]);
  });
});

/* ------------------------------------------------ single-row (getBrand) reads */

const MARLEY_ROW = {
  slug: DEFAULT_BRAND,
  name: "Marley Moves",
  short_name: "Marley",
  group_line: "",
  legal_line: "MarleyMoves Ltd",
  phone: "01747 637070",
  active: true,
  sort_order: 0,
};

const PITMANS_ROW = {
  slug: "pitmans",
  name: "Pitmans Removals & Storage",
  short_name: "Pitmans",
  group_line: "Part of the Marley Group",
  legal_line: "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd.",
  phone: "01258 858564",
  active: true,
  sort_order: 1,
};

/**
 * Keyed single-row stub: `resolve(slug)` returns the row, `null` for a genuine
 * MISS, or throws a sentinel the stub converts into a PostgREST-shaped error —
 * the two answers the defect under test collapsed into one.
 */
function sbBySlug(
  resolve: (slug: string) => Record<string, unknown> | null | "error",
): SupabaseClient {
  let asked = "";
  const answer = () => {
    const row = resolve(asked);
    return Promise.resolve(
      row === "error"
        ? { data: null, error: { message: "connection reset" } }
        : { data: row, error: null },
    );
  };
  const chain = {
    select: () => chain,
    eq: (_col: string, v: string) => ((asked = v), chain),
    neq: () => chain,
    order: () => answer(),
    maybeSingle: () => answer(),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("a single brand read distinguishes a FAILURE from a MISS", () => {
  it("getBrand THROWS on a query error rather than reporting the brand absent", async () => {
    await expect(getBrand(sbBySlug(() => "error"), "pitmans")).rejects.toThrow(
      /brand read failed \(pitmans\): connection reset/,
    );
  });

  it("getBrand still returns null for a genuine miss", async () => {
    expect(await getBrand(sbBySlug(() => null), "nope")).toBeNull();
  });

  it("getBrandOrDefault REFUSES a failed read for a non-default slug — it never answers as another brand", async () => {
    await expect(getBrandOrDefault(sbBySlug(() => "error"), "pitmans")).rejects.toThrow(
      /brand read failed \(pitmans\)/,
    );
  });

  it("getBrandOrDefault still degrades a genuine miss to the default row", async () => {
    const brand = await getBrandOrDefault(
      sbBySlug((slug) => (slug === DEFAULT_BRAND ? MARLEY_ROW : null)),
      "gone",
    );
    expect(brand.slug).toBe(DEFAULT_BRAND);
  });

  it("getBrandOrDefault resolves a real non-default row unchanged", async () => {
    const brand = await getBrandOrDefault(sbBySlug(() => PITMANS_ROW), "pitmans");
    expect(brand).toMatchObject({ slug: "pitmans", phone: "01258 858564" });
  });

  it("a failed read for the DEFAULT slug degrades to the default identity — the fallback IS what was asked for", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const brand = await getBrandOrDefault(sbBySlug(() => "error"), DEFAULT_BRAND);
      expect(brand.slug).toBe(DEFAULT_BRAND);
      expect(spy).toHaveBeenCalled(); // degraded, but never silently
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listBrandIdentities — the identity map for records already on the books", () => {
  it("THROWS on a query error rather than answering 'no such brand' for live rows", async () => {
    await expect(listBrandIdentities(sbFailing("boom"))).rejects.toThrow(/brands read failed: boom/);
  });

  it("includes INACTIVE brands — deactivation stops new work, it does not rewrite old jobs", async () => {
    const brands = await listBrandIdentities(
      sbReturning([MARLEY_ROW, { ...PITMANS_ROW, active: false }]),
    );
    expect(brands.map((b) => b.slug)).toEqual([DEFAULT_BRAND, "pitmans"]);
    expect(brands[1]).toMatchObject({ active: false, phone: "01258 858564" });
  });
});
