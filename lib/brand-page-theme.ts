import {
  DEFAULT_BRAND,
  GROUP_BRAND,
  brandCtaColour,
  brandCtaColourDeep,
  hexWithAlpha,
  type Brand,
} from "@/lib/brand";

/**
 * Brand identity for the PUBLIC token pages — `/q`, `/s`, `/cv`, `/sheet`,
 * `/join` (multi-brand PRD §4, gate 16).
 *
 * The third member of a family that already exists: `emailTheme` does this for
 * comms and `docBrandFrom` does it for PDFs. A third ad-hoc resolution per page
 * is how five surfaces come to disagree about one brand's phone number, so this
 * rhymes with `emailTheme` deliberately — including its most important
 * property.
 *
 * ## The default theme is LITERAL
 *
 * Marley's theme never reads the brands row. That is the single-brand invariant
 * (PRD §1): with one active brand these pages must be byte-identical to today,
 * and a Marley row with a stale colour or an unset card flag must not be able
 * to edit what a live customer reads. Same rule `emailTheme` is byte-locked to.
 *
 * ## Why colours come back as a class AND a style
 *
 * Today's pages use Tailwind's `text-mm-red`. A branded page needs an arbitrary
 * hex, which Tailwind cannot generate at runtime. Returning both — the class
 * for Marley, an inline style for everyone else — means the Marley render emits
 * exactly the markup it does now (`style={undefined}` renders no attribute),
 * rather than a computed inline colour that merely happens to be the same red.
 *
 * ## The named person
 *
 * `/q` says "Call Connor on 01747 637070". Connor is a real person at Marley
 * Moves; on a Pitmans page his name is simply wrong, and it is the kind of
 * wrong a customer notices. `callLead` carries the words before the number so
 * the default keeps its exact wording and every other brand gets "Call us".
 */
export interface PageTheme {
  slug: string;
  /** Customer-facing name — page title, logo alt text, wordmark. */
  name: string;
  /** Footer identity line. */
  legalLine: string;
  /**
   * The OPERATING COMPANY — the same for every brand, because every brand is
   * a trading name of it (PRD §2). Named here rather than written into each
   * page so the one legitimate use of that name on a customer surface — the
   * bank-transfer disclosure, which exists precisely to explain why the
   * account is not the brand's own — is not indistinguishable from a leak.
   * `emailTheme.payToNoteHtml` carries the same sentence for comms.
   */
  legalEntity: string;
  /** "Part of the Marley Group" — required wherever a non-default brand's logo
   *  appears (PRD §2). Empty for the default brand, which IS the group. */
  groupLine: string;
  phone: string;
  /** `tel:` href, punctuation stripped. */
  telHref: string;
  /** Logo image, or null → render `name` as a wordmark instead. */
  logoUrl: string | null;
  /** Wordmark colour when there is no logo (same data rule as branded-shell). */
  wordmarkColour: string;
  termsUrl: string;
  /**
   * CSS-variable overrides for the page's ROOT element — the whole accent
   * mechanism, in one place.
   *
   * Tailwind v4 compiles `.text-mm-red` to `color: var(--color-mm-red)`, so
   * redefining that variable on a container re-colours every descendant that
   * uses the token — text, borders, and the `hover:`/`focus:` variants that an
   * inline style cannot express at all. The alternative (threading an accent
   * prop into every component and pairing a class with a style on each
   * element) touches ~20 call sites across five files to achieve less.
   *
   * `undefined` for the default brand, so a Marley page renders the exact
   * markup and the exact colours it does today — not a computed inline value
   * that merely happens to match.
   */
  rootStyle: Record<string, string> | undefined;
  /** Whether card may be MENTIONED to this brand's customers at all (PRD
   *  §11.10 — the global kill switch is the caller's other half). */
  cardEnabled: boolean;
  /** The words before the phone link — "Call Connor on" / "Call us on". Split
   *  from the number rather than baked into one phrase because every call site
   *  renders the number as a `tel:` link, not as text. */
  callLead: string;
}

/** Local asset — served from this app so the customer surface has no cross-app
 *  dependency (the pages used to pull it from the separate quotes-app domain). */
const MARLEY_LOGO_URL = "/logo.png";
const MARLEY_PHONE = "01747 637070";

/**
 * Today's literals, verbatim. Every string here is lifted unchanged from the
 * pages it replaces, so the default render cannot drift.
 */
const MARLEY_THEME: PageTheme = {
  slug: DEFAULT_BRAND,
  name: "Marley Moves",
  legalLine: "Marley Moves Ltd · Company No. 15914266 · Shaftesbury, SP7",
  legalEntity: "MarleyMoves Ltd",
  groupLine: "",
  phone: MARLEY_PHONE,
  telHref: "tel:01747637070",
  logoUrl: MARLEY_LOGO_URL,
  wordmarkColour: "#1A1A1A",
  termsUrl: "https://marleymoves.co.uk/terms-conditions/",
  rootStyle: undefined,
  cardEnabled: true,
  callLead: "Call Connor on",
};

const INK = "#1A1A1A";

/**
 * The mm-red token FAMILY, re-pointed at one accent.
 *
 * All four are overridden together on purpose. Overriding only the base would
 * leave every hover state (`-deep`), every dark-surface accent (`-bright`) and
 * every soft fill (`-tint`) rendering Marley red on a page whose text had gone
 * blue — a half-themed page reads as a bug rather than as another brand.
 */
function accentVars(accent: string): Record<string, string> {
  return {
    "--color-mm-red": accent,
    "--color-mm-red-deep": brandCtaColourDeep(accent),
    "--color-mm-red-bright": accent,
    "--color-mm-red-tint": hexWithAlpha(accent, 0.08),
  };
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/**
 * The theme for a token page.
 *
 * Absent, null, or the default brand returns the literal above. The `group`
 * pseudo-brand also returns it for identity — `/sheet` and `/join` are group
 * surfaces (PRD §4) and the group's identity IS Marley Moves Ltd — but with the
 * accent neutralised, because a group surface carries no brand colour.
 */
export function pageTheme(brand?: Brand | null): PageTheme {
  if (!brand || brand.slug === DEFAULT_BRAND) return MARLEY_THEME;

  if (brand.slug === GROUP_BRAND) {
    return {
      ...MARLEY_THEME,
      slug: GROUP_BRAND,
      // Charcoal, not brand red: a crew day sheet legitimately spans brands, so
      // colouring it as one of them would claim something untrue about the
      // other's jobs (PRD §4 — group surfaces are neutral).
      rootStyle: accentVars(INK),
    };
  }

  const name = brand.name.trim() || MARLEY_THEME.name;
  // No fallback, for the same reason as the logo below — and this one is
  // sharper, because a phone number is ACTIONABLE. The default brand's number
  // on another brand's page is a live tel: link to an office that has never
  // heard of the customer holding it, on every /q, /s and /cv state. The blank
  // is reachable without a deploy (Settings › Brands takes free text and
  // lib/brand-update.ts maps "" → null), and it is invisible to the source-
  // level brand-leak scan because the number arrives through a token. A
  // required string is the only shape this type allows, so the honest answer
  // is to refuse the render and name the fix, loudly, on the request that
  // caused it. The default brand never reaches here — its theme is the literal
  // above — so a single-brand install cannot be broken by this.
  const phone = (brand.phone ?? "").trim();
  if (!phone) {
    throw new Error(
      `Brand "${brand.slug}" has no phone number, so its customer pages cannot be rendered. Add one in Settings › Brands.`,
    );
  }
  const accent = brandCtaColour(brand) ?? "#C03838";
  const primary = (brand.colourPrimary ?? "").trim();

  return {
    slug: brand.slug,
    name,
    legalLine: brand.legalLine.trim() || MARLEY_THEME.legalLine,
    legalEntity: MARLEY_THEME.legalEntity,
    groupLine: brand.groupLine.trim(),
    phone,
    telHref: "tel:" + phone.replace(/[^0-9+]/g, ""),
    // A non-default brand's logo_url is remote and, until Phase 0 delivers the
    // real asset, a stub — so a missing one renders the NAME rather than
    // Marley's own /logo.png, which would put the wrong logo on the page.
    logoUrl: (brand.logoUrl ?? "").trim() || null,
    wordmarkColour: HEX_COLOUR.test(primary) ? primary : "#1A1A1A",
    termsUrl: (brand.termsUrl ?? "").trim() || MARLEY_THEME.termsUrl,
    rootStyle: accentVars(accent),
    cardEnabled: brand.cardPaymentsEnabled,
    // Never a named individual. Connor is a real person at Marley Moves and
    // means nothing to a Pitmans customer.
    callLead: "Call us on",
  };
}

/**
 * The GROUP surface theme — `/sheet` and `/join`, which serve one shared crew
 * across every brand (PRD §4).
 *
 * Exported rather than reached by casting `{ slug: GROUP_BRAND }` to a Brand:
 * that cast happens to work only because the group branch reads nothing else,
 * and it would start returning undefined fields the moment that stopped being
 * true. Identity is the operating company's; the accent is neutral, because a
 * crew day legitimately spans brands and colouring it as one would claim
 * something untrue about the other's jobs.
 */
export const GROUP_PAGE_THEME: PageTheme = pageTheme({
  ...MARLEY_THEME,
  slug: GROUP_BRAND,
} as unknown as Brand);

/**
 * The page `<title>` for a theme.
 *
 * A free function rather than a field on PageTheme, because the theme is
 * passed as a PROP into client components (`/q`'s accept form, the card
 * button, the commitment choice) and React cannot serialise a function across
 * that boundary — it fails at render with a message about the boundary rather
 * than about the field, which is a poor way to find out.
 */
export function pageTitle(theme: PageTheme, what: string): string {
  return `${what} — ${theme.name}`;
}
