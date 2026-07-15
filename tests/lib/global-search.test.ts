import { describe, expect, it } from "vitest";
import { MIN_SEARCH_LEN, sanitiseSearchTerm } from "@/components/search/search-utils";

describe("sanitiseSearchTerm", () => {
  it("strips the PostgREST filter-grammar characters", () => {
    // commas + parens delimit conditions, %/* are wildcards, backslash/quote escape
    expect(sanitiseSearchTerm('a,b(c)d%e*f\\g"h')).toBe("abcdefgh");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitiseSearchTerm("  MMR001  ")).toBe("MMR001");
  });

  it("leaves legitimate ref / name / postcode characters intact", () => {
    expect(sanitiseSearchTerm("SP7 9PX")).toBe("SP7 9PX");
    expect(sanitiseSearchTerm("O'Brien")).toBe("O'Brien");
    expect(sanitiseSearchTerm("MMC001")).toBe("MMC001");
  });

  it("handles nullish input without throwing", () => {
    expect(sanitiseSearchTerm(undefined as unknown as string)).toBe("");
    expect(sanitiseSearchTerm(null as unknown as string)).toBe("");
  });

  it("collapses a wildcard-only query below the minimum length", () => {
    // A user typing only '%' or '(' would otherwise become an empty ilike that
    // matches everything — sanitising drops it under MIN_SEARCH_LEN so we skip the DB.
    expect(sanitiseSearchTerm("%(").length).toBeLessThan(MIN_SEARCH_LEN);
  });
});
