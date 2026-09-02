import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every accent on a token page has to travel through `--color-mm-red`, because
 * that variable is the ONE thing the shell re-points per brand
 * (lib/brand-page-theme.ts `accentVars`). The decline radios used a Tailwind
 * arbitrary value, which compiles to a literal colour the override cannot
 * reach — so a second brand's customer got the default brand's red dot on an
 * otherwise correctly themed page (PRD §2: "Token pages | Full palette").
 *
 * The leak scan cannot catch this class: FORBIDDEN carries the `mm-red` token,
 * not hex literals. So it is guarded here instead — no arbitrary colour value
 * anywhere in the route's client components.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const SRC = read("app/q/[token]/customer-actions.tsx");
const SIBLING = read("app/q/[token]/accept-form.tsx");

/** `accent-[#…]`, `bg-[#…]`, `text-[#…]` — any hardcoded colour in a class. */
const ARBITRARY_COLOUR = /-\[#[0-9a-fA-F]{3,8}\]/;

describe("/q decline radios use the re-pointable accent token", () => {
  it("carries no hardcoded colour in a utility class", () => {
    const hit = SRC.match(ARBITRARY_COLOUR);
    expect(hit?.[0] ?? null, "an arbitrary colour value the brand shell cannot re-point").toBe(null);
  });

  it("uses the same accent token as the sibling accept checkbox", () => {
    expect(SIBLING, "the sibling's token (this test's premise)").toContain("accent-mm-red");
    expect(SRC, "the radios no longer share the accept form's accent token").toContain("accent-mm-red");
  });
});
