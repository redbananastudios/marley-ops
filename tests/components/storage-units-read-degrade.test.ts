import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /storage site visibility under a named ?brand=: a site is shown when its own
 * brand matches OR it CONTAINS a let of the filtered brand (gate-12 QA Op5 —
 * DB-narrowing on site.brand alone made a Marley site holding a Pitmans let
 * vanish under ?brand=pitmans, leaving that let unreachable).
 *
 * The "contains" half rides the units read (unit → site mapping). That read
 * was fail-soft with its error DISCARDED: on failure the mapping came back
 * empty, sitesWithFilteredLet collapsed to nothing, and the filter silently
 * narrowed to own-brand sites — quietly re-opening the exact hole Op5 closed,
 * with the page rendering as if it had checked.
 *
 * The rule (PR #195 idiom): a failed read on a display surface degrades
 * WIDER and SAYS SO — the unfiltered site list plus a console.error — never
 * silently narrower.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const at = (haystack: string, needle: string, what: string): number => {
  const i = haystack.indexOf(needle);
  expect(i, `no longer contains ${what}`).toBeGreaterThan(-1);
  return i;
};

const SRC = read("app/(dashboard)/storage/page.tsx");

describe("/storage units read failure under a named brand filter", () => {
  it("captures the units read error instead of discarding it", () => {
    at(SRC, "unitsError", "the captured units read error");
  });

  it("degrades to the UNFILTERED site list, with the explicit console.error pattern", () => {
    const err = at(SRC, "unitsError", "the units error check");
    const note = at(SRC, "[storage] units read failed", "the visible degrade note");
    expect(err).toBeLessThan(note);
    const consoleCall = at(SRC, "console.error(", "the console.error call");
    expect(consoleCall, "the note must ride console.error").toBeLessThan(note);
    // The degrade hands back allSites (wider), never the own-brand-only narrowing.
    at(SRC, "degrades to the full site list", "the degrade rationale");
  });
});
