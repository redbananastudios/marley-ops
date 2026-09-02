import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageTheme, pageTitle, type PageTheme } from "@/lib/brand-page-theme";
import { DEFAULT_BRAND, GROUP_BRAND, type Brand } from "@/lib/brand";

/**
 * Gate 16 — brand identity for the public token pages.
 *
 * The single-brand invariant (PRD §1) is the property everything else here
 * rests on: with one active brand these pages must render exactly what they
 * render today. So the default theme is asserted as LITERALS, lifted from the
 * pages this seam replaced. A test that compared the theme to the brands row
 * would pass just as happily against a Marley row somebody had edited.
 */

const brand = (over: Partial<Brand> = {}): Brand =>
  ({
    slug: "pitmans",
    name: "Pitmans Removals & Storage",
    shortName: "Pitmans",
    initial: "P",
    groupLine: "Part of the Marley Group",
    legalLine:
      "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd. Company No. 15914266.",
    refPrefix: "PM",
    colourPrimary: "#2B2B76",
    colourAccent: "#F5C518",
    logoUrl: null,
    groupLogoUrl: null,
    emailDomain: null,
    helloFrom: null,
    accountsFrom: null,
    replyDomain: null,
    smsSender: null,
    phone: "01258 858564",
    address: null,
    websiteUrl: "https://pitmansremovals.co.uk",
    reviewUrl: null,
    termsUrl: "https://pitmansremovals.co.uk/terms/",
    baseLocation: null,
    cardPaymentsEnabled: false,
    ledgerBrandingId: null,
    ...over,
  }) as Brand;

describe("the default theme is today's page, verbatim", () => {
  const t = pageTheme(null);

  it("absent ≡ null ≡ the marley row", () => {
    expect(pageTheme()).toEqual(t);
    expect(pageTheme(brand({ slug: DEFAULT_BRAND }))).toEqual(t);
  });

  it("carries the literals the pages used to hardcode", () => {
    expect(t.name).toBe("Marley Moves");
    expect(t.phone).toBe("01747 637070");
    expect(t.telHref).toBe("tel:01747637070");
    expect(t.logoUrl).toBe("/logo.png");
    expect(t.legalLine).toBe("Marley Moves Ltd · Company No. 15914266 · Shaftesbury, SP7");
    expect(t.termsUrl).toBe("https://marleymoves.co.uk/terms-conditions/");
    expect(t.callLead).toBe("Call Connor on");
    expect(pageTitle(t, "Your quote")).toBe("Your quote — Marley Moves");
  });

  it("renders NO style attribute and NO group line", () => {
    // `rootStyle: undefined` is the whole byte-identity claim: React emits no
    // style attribute at all, so the Marley page's markup is unchanged rather
    // than carrying a computed inline colour that merely equals the red.
    expect(t.rootStyle).toBeUndefined();
    // Marley IS the group, so "Part of the Marley Group" under its own logo
    // would be a strange thing to tell its customers.
    expect(t.groupLine).toBe("");
  });

  it("cannot be edited by a marley brand row", () => {
    // A Marley row with a wrong colour, a stale phone or card switched off must
    // not change what a live customer reads — the same rule email-brand.test.ts
    // byte-locks for comms. The row is ignored entirely.
    const rogue = brand({
      slug: DEFAULT_BRAND,
      name: "Not Marley",
      phone: "01111 111111",
      cardPaymentsEnabled: false,
      termsUrl: "https://example.com/terms",
    });
    expect(pageTheme(rogue)).toEqual(t);
  });
});

describe("a non-default brand replaces every piece of identity", () => {
  const t = pageTheme(brand());

  it("substitutes name, phone, terms and legal line", () => {
    expect(t.name).toBe("Pitmans Removals & Storage");
    expect(t.phone).toBe("01258 858564");
    expect(t.telHref).toBe("tel:01258858564");
    expect(t.termsUrl).toBe("https://pitmansremovals.co.uk/terms/");
    expect(t.legalLine).toContain("trading name of MarleyMoves Ltd");
  });

  it("carries the group line, which the default does not", () => {
    // PRD §2: required wherever a non-default brand's logo appears, so the
    // customer is not surprised by a MarleyMoves Ltd bank account or a Marley
    // van on the day.
    expect(t.groupLine).toBe("Part of the Marley Group");
  });

  it("names no individual", () => {
    // "Call Connor on…" is correct at Marley Moves and simply wrong anywhere
    // else — a real person's name in front of a customer who has never heard
    // of them.
    expect(t.callLead).toBe("Call us on");
    expect(JSON.stringify(t)).not.toContain("Connor");
  });

  it("leaks NO default-brand identity at all", () => {
    // The mechanical half of the brand-leak scan, applied to the seam every
    // page reads its identity from: if nothing Marley survives here, no page
    // downstream can print it from a theme.
    const flat = JSON.stringify(t);
    for (const literal of ["Marley Moves", "01747", "marleymoves.co.uk", "/logo.png", "#c03838"]) {
      expect(flat.toLowerCase(), `theme still carries ${literal}`).not.toContain(
        literal.toLowerCase(),
      );
    }
  });

  it("REFUSES a blank phone rather than borrowing the default brand's number", () => {
    // The Phone field is admin-editable free text with no non-empty rule
    // (lib/brand-update.ts optText maps "" → null), so one Settings save is
    // enough. Falling back would put a live tel: link to an office that has
    // never heard of this customer on ~30 render sites across /q, /s and /cv —
    // silently, permanently, and invisible to the source-level leak scan
    // because it arrives through a token. Refusing lands on the request that
    // caused it and names the fix. Same call as the logo above, and the only
    // one this type allows: `phone` is a required string every page prints.
    for (const blank of [null, "", "   "]) {
      expect(() => pageTheme(brand({ phone: blank }))).toThrow(/Settings › Brands/);
    }
    // The DEFAULT brand is untouched: its theme is the literal, read before
    // any row is consulted, so a blank Marley row cannot break today's pages.
    expect(pageTheme(brand({ slug: DEFAULT_BRAND, phone: null })).phone).toBe("01747 637070");
    // Group surfaces (/sheet, /join) carry the operating company's identity
    // and never reach the row's phone either.
    expect(pageTheme(brand({ slug: GROUP_BRAND, phone: null })).phone).toBe("01747 637070");
  });

  it("renders its NAME rather than borrowing Marley's logo", () => {
    // A brand whose logo asset has not landed yet (Phase 0) must not fall back
    // to /logo.png — the one wrong answer worse than showing no logo.
    expect(t.logoUrl).toBeNull();
    expect(t.wordmarkColour).toBe("#2B2B76");
    expect(pageTheme(brand({ logoUrl: "https://cdn.example/pitmans.png" })).logoUrl).toBe(
      "https://cdn.example/pitmans.png",
    );
  });
});

describe("the accent re-points the whole mm-red family", () => {
  const vars = (t: PageTheme) => t.rootStyle ?? {};

  it("overrides base, deep, bright and tint together", () => {
    // Overriding only the base would leave every hover state, dark-surface
    // accent and soft fill rendering Marley red on a page whose text had gone
    // blue — a half-themed page reads as a bug, not as another brand.
    const t = pageTheme(brand());
    expect(Object.keys(vars(t)).sort()).toEqual([
      "--color-mm-red",
      "--color-mm-red-bright",
      "--color-mm-red-deep",
      "--color-mm-red-tint",
    ]);
    for (const [name, value] of Object.entries(vars(t))) {
      expect(value, `${name} is empty`).toBeTruthy();
      expect(value.toLowerCase(), `${name} still resolves to Marley red`).not.toContain("c03838");
    }
  });

  it("the group pseudo-brand is neutral, not branded", () => {
    // /sheet and /join span brands by design (PRD §4), so colouring them as
    // either one would claim something untrue about the other's jobs.
    const g = pageTheme(brand({ slug: GROUP_BRAND }));
    expect(g.rootStyle?.["--color-mm-red"]).toBe("#1A1A1A");
    // …but its IDENTITY is still the operating company's.
    expect(g.name).toBe("Marley Moves");
    expect(g.phone).toBe("01747 637070");
  });
});

describe("card is a brand-level permission", () => {
  it("follows the row's own switch", () => {
    expect(pageTheme(brand({ cardPaymentsEnabled: false })).cardEnabled).toBe(false);
    expect(pageTheme(brand({ cardPaymentsEnabled: true })).cardEnabled).toBe(true);
  });

  it("is only ONE of the two switches a page must check", () => {
    // The global kill switch is the other half (PRD §11.10), and it lives in
    // business_settings — which this pure function cannot see. Pages must gate
    // card COPY on `cardPaymentsAvailable`, which ANDs both. This assertion
    // exists so that a future reader who finds `theme.cardEnabled` does not
    // mistake it for the whole answer.
    const page = readFileSync(join(process.cwd(), "app/q/[token]/page.tsx"), "utf8");
    expect(page).toContain("cardPaymentsAvailable(sb, quote.brand)");
    expect(page, "/q must not gate card copy on the brand flag alone").not.toContain(
      "theme.cardEnabled",
    );
  });
});

describe("/q reads its identity from the theme, not from literals", () => {
  const page = readFileSync(join(process.cwd(), "app/q/[token]/page.tsx"), "utf8");
  const actions = readFileSync(join(process.cwd(), "app/q/[token]/customer-actions.tsx"), "utf8");

  it("has no hardcoded phone number left, in either file", () => {
    // Twelve of them, across the not-found, declined, cancelled, expired,
    // failed-card, error-card, balance and footer states. The state a customer
    // lands in is not the state anyone tests first, which is why this asserts
    // the absence across the whole file rather than checking the happy path.
    expect(page).not.toContain("01747");
    expect(actions, "the error copy names a phone number too").not.toContain("01747");
  });

  it("resolves the brand once per entry point, before any branch renders", () => {
    // TWO resolutions, and both are correct: Next calls `generateMetadata` and
    // the page body as separate entry points, so the body's theme is not in
    // scope when the tab title is decided. `lib/brand.ts` deliberately has no
    // caching layer — a brand edit must show on the next request rather than
    // linger as a wrong logo on a customer surface — so this is two small reads
    // on one public page, not a memoisation bug to fix.
    expect(page.match(/pageTheme\(quote \? await getBrandOrDefault/g) ?? []).toHaveLength(2);

    // Inside the body, every early return — declined, not-found, cancelled,
    // expired — must come AFTER the resolution, or that state falls back to a
    // literal nobody remembered to update.
    const body = page.slice(page.indexOf("export default async function AcceptPage"));
    const resolved = body.indexOf("const theme = pageTheme(");
    expect(resolved, "the page body no longer resolves a theme").toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(body.indexOf("return <NotFoundCard"));
    expect(resolved).toBeLessThan(body.indexOf("Thanks for letting us know"));
  });

  it("paints the accent through ONE root override", () => {
    // Not per element: the child components use `hover:`/`focus:` accent
    // variants, which an inline style cannot express at all.
    expect(page).toContain("style={theme.rootStyle as React.CSSProperties | undefined}");
    // And the utility classes stay exactly as they were, which is what makes
    // the Marley render byte-identical.
    expect(page).toContain('className="mt-0.5 size-5 shrink-0 text-mm-red"');
  });

  it("titles the tab with the brand", () => {
    expect(page).toContain('pageTitle(theme, "Your quote")');
    expect(page, "a static metadata export cannot know the brand").not.toMatch(
      /export const metadata/,
    );
  });
});

describe("every token page reads its identity from the theme", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  // The five public token pages (PRD §4). /q is covered in detail above; these
  // assert the contract holds across the whole set, because the leak this gate
  // exists to stop is one page nobody converted rather than one line nobody
  // changed.
  const PAGES = [
    "app/q/[token]/page.tsx",
    "app/s/[token]/page.tsx",
    "app/cv/[token]/page.tsx",
    "app/sheet/[token]/page.tsx",
    "app/join/[token]/page.tsx",
  ];

  it.each(PAGES)("%s hardcodes no phone number", (rel) => {
    expect(read(rel)).not.toContain("01747");
  });

  it.each(PAGES)("%s hardcodes no brand name", (rel) => {
    // Comments included, deliberately: a source grep cannot tell a comment from
    // copy, and the brand-leak scan is right to be strict about it. Comments
    // here describe the mechanism instead of naming a brand.
    expect(read(rel)).not.toContain("Marley");
  });

  it.each(PAGES)("%s applies the accent as a root override", (rel) => {
    // Not per element: the child components use `hover:`/`focus:` accent
    // variants that an inline style cannot express.
    expect(read(rel)).toContain("theme.rootStyle as React.CSSProperties | undefined");
  });

  it("the two GROUP surfaces take the group theme, not a brand's", () => {
    // A crew day spans brands by design, so /sheet and /join must not be
    // coloured or worded as either one.
    for (const rel of ["app/sheet/[token]/page.tsx", "app/join/[token]/page.tsx"]) {
      const src = read(rel);
      expect(src, `${rel} should use the group theme`).toContain("GROUP_PAGE_THEME");
      expect(src, `${rel} must not resolve a record's brand`).not.toContain("getBrandOrDefault");
    }
  });

  it("the two RECORD surfaces resolve the brand of the record they show", () => {
    // /s from the storage let, /cv from the lead — both carry a brand column
    // (gates 12 and 1). Reading anything else would show one customer another
    // customer's brand.
    expect(read("app/s/[token]/page.tsx")).toContain("getBrandOrDefault(admin, let_.brand)");
    expect(read("app/cv/[token]/page.tsx")).toContain("getBrandOrDefault(admin, lead.brand)");
  });

  it("the group theme is a real export, not a cast", () => {
    // `pageTheme({ slug: GROUP_BRAND } as Brand)` happens to work only because
    // the group branch reads no other field, and would start returning
    // undefined the moment that changed.
    const theme = read("lib/brand-page-theme.ts");
    expect(theme).toContain("export const GROUP_PAGE_THEME: PageTheme");
    for (const rel of ["app/sheet/[token]/page.tsx", "app/join/[token]/page.tsx"]) {
      expect(read(rel), `${rel} still fakes a Brand row`).not.toContain("as Brand)");
    }
  });
});
