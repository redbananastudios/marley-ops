import { test, expect, type Page } from "@playwright/test";
import { step } from "../fixtures/artefacts";
import { E2E_DB_READY, adminClient } from "../fixtures/db";
import { SEED } from "../fixtures/seed-data";
import { FORBIDDEN, findLeaksInContent } from "../../scripts/brand-leak-literals.mjs";

/**
 * Brand-leak scan — the RENDERED half (multi-brand PRD §6 addition 4; §10
 * "Where the brand-leak scan lives": "a source grep over brand-specific paths
 * … and a Playwright assertion over rendered Pitmans pages on staging. Source
 * grep catches the class; the rendered check catches what the grep can't see
 * through a token.").
 *
 * `scripts/brand-leak-scan.mjs` is the other half. It reads SOURCE, and it is
 * structurally blind to three routes a brand literal can take to a customer's
 * screen: a value stored in the database, a string assembled by a helper the
 * manifest does not list, and a Tailwind token that is RE-POINTED at runtime
 * rather than replaced. That last one is not hypothetical — the manifest's own
 * gate-16 entries carry an `mm-red` allow and say so in as many words: "these
 * are record surfaces whose token is re-pointed per brand at runtime, which a
 * source grep cannot see. That is exactly the gap the RENDERED half of this
 * scan exists to close."
 *
 * ## The one list
 *
 * `FORBIDDEN` and the detector that reads it are IMPORTED, never restated. Two
 * lists that must agree will drift, and the drift would be silent in the worst
 * direction: a literal added to one and missed in the other would read as "the
 * rendered pages are clean" while nothing had ever looked for it.
 *
 * They come from `scripts/brand-leak-literals.mjs` rather than straight from
 * `scripts/brand-leak-scan.mjs`, and that indirection is a real constraint, not
 * a preference. Playwright transpiles a spec and everything it imports to
 * CommonJS; the scan script uses `import.meta.url` to resolve the repo root, and
 * `import.meta` is a load-time syntax error under that transform ("Cannot use
 * 'import.meta' outside a module" — verified, not assumed). The scan cannot give
 * that line up, so the two things both halves need — the list and the matcher —
 * live in a module with no filesystem awareness, which the scan re-exports. One
 * list, three readers: the source grep, its vitest twin, and this spec.
 *
 * Two literals are handled differently here, and both differences are asserted
 * rather than assumed:
 *
 *   - `mm-red` is deliberately NOT scanned in rendered output. The class names
 *     are SUPPOSED to survive on a Pitmans page — gate 16's whole mechanism is
 *     one `--color-mm-red` override on the page root, so asserting the token
 *     absent would assert against the design. What replaces it is strictly
 *     stronger and only a rendered check can do it: the COMPUTED accent must be
 *     this brand's own colour, and on a default-brand page there must be no
 *     override at all (the §1 byte-parity invariant, observed rather than
 *     argued). The exclusion is evidence-disciplined — if `mm-red` ever leaves
 *     FORBIDDEN, the filter below would silently exempt nothing, so its
 *     presence is asserted.
 *   - the direction filter (`brand: 'marley'` literals on a Pitmans page,
 *     `brand: 'pitmans'` literals on a Marley one) is derived from the same
 *     rows, and both resulting sets are asserted non-empty. A scan whose
 *     literal list filtered to zero must fail, not report clean.
 *
 * ## Permitted occurrences, and why they are not a blanket allow
 *
 * Three default-brand strings reach a Pitmans page LEGITIMATELY, each mandated
 * or documented by the PRD, so a naive assertion would be red on a correct
 * build:
 *
 *   - "Part of the Marley Group" — PRD §2 requires the group mark wherever a
 *     non-default brand's logo appears. Its ABSENCE is the defect, so it is
 *     asserted present as well as exempted.
 *   - "MarleyMoves Ltd" — the operating company. Every brand is a trading name
 *     of it, the bank account is its account, and PRD §2/§3.5 put that
 *     disclosure in front of the customer on purpose.
 *   - the marleymoves.co.uk TERMS URLs — `brands.terms_url` is null for Pitmans
 *     and `publicUrlFor()` is brand-blind, so both link to Marley's documents.
 *     That is the documented state of play until GATE 15 ships Mark's unified
 *     brand-neutral terms (0104_brands.sql: "terms_url null renders Marley
 *     terms until gate 15 ships the unified brand-neutral document").
 *
 * These are scoped to the exact string, on the exact surface, with a stated
 * reason — the same discipline the source scan's `{ pattern, allow, reason }`
 * entries carry, including its dead-allow rule: an exemption marked `mustOccur`
 * that stops occurring is an ERROR, so it cannot outlive its justification. The
 * gate-15 exemptions are marked that way deliberately: when Pitmans gets its
 * own terms URL, this spec fails and tells you to delete them.
 *
 * ## The accent expectation is RE-DERIVED here, never imported
 *
 * The colour half asserts the computed accent equals the ONE colour the data
 * rule says this brand's pages must render — not "either of the brand's two
 * colours", which is the shape that passes on the exact regression it exists to
 * catch. `brandCtaColour` prefers `colour_accent` but only while white text on
 * it is legible; the second brand's accent is a yellow reserved for large flat
 * areas (PRD §11.4), so the rule REJECTS it and the primary is what must paint
 * every CTA. Accepting either colour would green a build in which that
 * legibility rule had been deleted and every button had turned white-on-yellow.
 *
 * `expectedAccent()` below therefore re-implements the rule from the brands row
 * rather than importing `brandCtaColour`. That duplication is deliberate and
 * runs the OPPOSITE way to the one-list rule above: a second copy of the
 * forbidden-literal DATA would under-check silently (a literal missing from one
 * copy is never looked for), whereas a second copy of a RULE over-constrains —
 * if the app's rule changes, this fails loudly and a human decides whether the
 * change was intended. An oracle that imports the code it checks moves with the
 * bug and cannot see it.
 *
 * ## Fixture naming: swept AND unique-per-run
 *
 * Every row this spec creates is named `E2E QA-SENTINEL-BRAND-LEAK-RENDERED
 * <run> …` and every unique column (quote ref, the three tokens) carries the
 * same `<run>` suffix. Both halves are load-bearing:
 *
 *   - the `E2E ` PREFIX puts them inside `scripts/seed-e2e.mjs`'s existing
 *     `ilike('E2E %')` sweep (leads → their quotes/surveys/activities, storage
 *     sites → units/lets/signatures, clients), so anything a killed process
 *     leaves behind is reclaimed by the next reseed instead of sitting in
 *     staging forever. The site fixture was already named this way and the rest
 *     were not; that inconsistency was itself the bug.
 *   - the per-run SUFFIX means a leftover row can never collide with this run.
 *     `quotes.quote_ref`, `quotes.accept_token`, `storage_lets.sign_token` and
 *     `cubic_surveys.share_token` are all UNIQUE, so a hardcoded value turns one
 *     leaked row into a duplicate-key failure on every subsequent run — the
 *     failure repeats forever and leaks two more rows each time. Same shape as
 *     `office/payments-commercial-ladder.spec.ts`'s `QASENT-CML-${Date.now()}`.
 *
 * ## "I checked nothing" is a failure state, not a pass
 *
 * A green brand-leak check that visited zero Pitmans pages is worse than no
 * check: it removes the signal while claiming the coverage. So every
 * precondition fails LOUDLY rather than skipping —
 *
 *   - no service-role credentials **in CI** → throw (the e2e job exports both;
 *     their absence is a job misconfiguration, and skipping would hand the gate
 *     a green badge for a check that never opened a page). Outside CI the file
 *     skips, because a dev checkout genuinely has no staging service key and
 *     the whole suite is unrunnable there — a skip reads as "did not run", the
 *     honest answer, whereas a hard failure would be noise. This is the ONE
 *     precondition allowed to skip and it can only skip where the check was
 *     never possible.
 *   - no `pitmans` brands row, or the row is inactive, or it has no phone →
 *     throw in `beforeAll` with the specific reason.
 *   - any surface answering anything but 200, or rendering something other than
 *     its expected state → throw. That covers the GROUP surfaces too, and it is
 *     not a formality there: `/sheet` serves "This job sheet has expired" (any
 *     work_date more than STALE_DAYS=3 old) and "We can't load your sheet right
 *     now" (day assembly failed twice), and `/join` serves its dead-link card
 *     (wrong token, or `staff_onboard_enabled` off), all at HTTP 200 and all
 *     wearing the very charcoal accent this file asserts. The seeded day sheet
 *     is dated TOMORROW, so a stale seed puts the expired card on screen — every
 *     one of those states is refused by name below, because a group pass that
 *     greened over two error cards would report colour coverage it never had.
 *   - a surface whose rendered TEXT is barely there → throw. The precondition
 *     measures the text a person can read, not the markup: any Next.js response
 *     carries thousands of characters of markup (a not-found card included), so
 *     a threshold over the combined length is inert by construction and would
 *     pass a page whose body was empty.
 *   - fewer surfaces visited than the manifest of surfaces declares → throw,
 *     naming the count.
 */

/** Playwright's env is the CI e2e job's env — see .github/workflows/staging.yml. */
const IN_CI = !!process.env.CI;

test.skip(
  !E2E_DB_READY && !IN_CI,
  "brand-leak (rendered) needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to seed a Pitmans record. Outside CI this reports DID NOT RUN; inside CI it fails instead.",
);

/**
 * One run's stamp. Short, and safe inside a token (base-36, so `[\w-]` only).
 * `Date.now()` alone would collide between two runs started in the same
 * millisecond — two CI runs racing the same staging database is a documented
 * hazard here (e2e/README.md), so a little entropy rides along.
 */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The name every row this spec creates begins with.
 *
 * The `E2E ` prefix is what puts these rows inside `scripts/seed-e2e.mjs`'s
 * `ilike('E2E %')` sweep, so a killed process cannot leak a marker set into
 * staging permanently (see the header). `RUN_MARKER` — the same string plus this
 * run's stamp — is written to every `notes` column and is the key the teardown
 * reads back on, so the read-back proves THIS run cleaned up after itself and
 * can never be satisfied (or tripped) by a concurrent run's rows.
 */
const MARKER = "E2E QA-SENTINEL-BRAND-LEAK-RENDERED";
const RUN_MARKER = `${MARKER} ${RUN}`;
const SECOND_BRAND = "pitmans";

/**
 * Tokens must satisfy the routes' own `/^[\w-]{10,64}$/` guard, and are
 * per-run because all three columns are UNIQUE — a fixed value turns one leaked
 * row into a duplicate-key failure on every later run.
 */
const TOKENS = {
  quote: `e2e-brandleak-pm-q-${RUN}`,
  storage: `e2e-brandleak-pm-s-${RUN}`,
  cubic: `e2e-brandleak-pm-cv-${RUN}`,
} as const;

/** `quotes.quote_ref` is UNIQUE (0001_init.sql) — per-run for the same reason. */
const QUOTE_REF = `E2E-BLEAK-PM-${RUN}`;

/** The `:root` value of the accent token — what a default-brand page renders. */
const DEFAULT_ACCENT = "#c03838";
/** GROUP_PAGE_THEME's neutral charcoal (lib/brand-page-theme.ts `INK`). */
const GROUP_ACCENT = "#1a1a1a";

/**
 * The shortest rendered TEXT any of these five surfaces legitimately produces.
 *
 * The floor exists to catch "the page did not render", so it is measured
 * against the leanest real state rather than set decoratively: `/cv` on a
 * COMPLETE survey renders a heading, one sentence and the legal line — a little
 * over 170 characters — and every other state is far longer. Below this and a
 * body is effectively empty, which is precisely what the old combined
 * text+markup measure could never see (markup alone scores thousands on a
 * not-found card).
 */
const MIN_RENDERED_TEXT = 120;

const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

// ------------------------------------------------------------ the accent rule

/** "#rrggbb" → [r, g, b], or null for anything else. */
function parseHex(v: string | null | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((v ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG contrast of white text on `rgb` clears the 3:1 large-text/UI bar. */
function whiteTextLegible([r, g, b]: [number, number, number]): boolean {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return 1.05 / (luminance + 0.05) >= 3;
}

/**
 * The ONE colour this brand's customer pages are supposed to render, derived
 * from the brands row by the data rule the app states in `brandCtaColour`'s own
 * doc comment: prefer `colour_accent`, but only while white text on it is
 * legible — a light accent (a yellow reserved for large flat areas, PRD §11.4)
 * falls back to `colour_primary`. Null when the row carries no usable colour,
 * which is a defect in the row rather than in the page.
 *
 * RE-DERIVED, never imported (see the header). Asserting "the accent is either
 * of the brand's two colours" — which is what this replaces — passes on exactly
 * the regression the check exists for: delete the legibility rule and every CTA
 * on a second-brand /q, /s and /cv turns white-on-yellow while the assertion
 * still greens, because the yellow IS one of the two.
 */
function expectedAccent(row: BrandRow): string | null {
  const accent = parseHex(row.colour_accent);
  if (accent && whiteTextLegible(accent)) return (row.colour_accent ?? "").trim().toLowerCase();
  const primary = parseHex(row.colour_primary);
  if (primary && whiteTextLegible(primary)) return (row.colour_primary ?? "").trim().toLowerCase();
  return null;
}

// ---------------------------------------------------------------- the lists

/**
 * `mm-red` is excluded from the rendered scan by design (see the header). If it
 * ever leaves FORBIDDEN this filter would quietly exempt nothing, so its
 * presence is a precondition of the exclusion, not an assumption.
 */
const MM_RED = "mm-red";

const literalsFor = (brand: string) =>
  FORBIDDEN.filter((f) => f.brand === brand && f.literal !== MM_RED);

// ------------------------------------------------------- permitted occurrences

interface Permitted {
  /** The exact string that may legitimately carry a default-brand literal. */
  text: string;
  /** Why it is not a leak — PRD clause or the gate that retires it. */
  reason: string;
  /** True → zero occurrences is an ERROR (the dead-allow rule). */
  mustOccur: boolean;
}

const TERMS_URL = "https://marleymoves.co.uk/terms-conditions/";
const STORAGE_TERMS_URL = "https://marleymoves.co.uk/storage-terms/";

/**
 * The operating company. Deliberately the shortest string that covers both its
 * appearances — `pageTheme.legalEntity` and the trading-name clause inside
 * `brands.legal_line` — so a leak of any OTHER Marley string is still caught.
 */
const LEGAL_ENTITY = "MarleyMoves Ltd";

const groupMark = (row: BrandRow): Permitted => ({
  text: row.group_line,
  mustOccur: true,
  reason:
    "PRD §2: the group mark is REQUIRED wherever a non-default brand's logo appears, so a customer is not surprised by the operating company's bank account. Rendered unconditionally by all three record surfaces; its absence is the defect.",
});

const legalEntity: Permitted = {
  text: LEGAL_ENTITY,
  mustOccur: false,
  reason:
    "PRD §2/§3.5: the OPERATING COMPANY, of which every brand is a trading name — the one legitimate use of that name on a customer surface. Reached via pageTheme.legalEntity and the brand's own legal_line; some /q states render neither.",
};

const appOrigin: Permitted = {
  text: "ops.marleymoves.co.uk",
  mustOccur: false,
  reason:
    "the APP's own origin, not document identity — one app hosts every brand (app chrome per PRD §2, the same grounds lib/job-sheet-load.ts is exempted on in the source manifest). Absent from a page that links nothing back to itself.",
};

const gate15 = (text: string, which: string): Permitted => ({
  text,
  mustOccur: true,
  reason: `GATE 15 PENDING: brands.terms_url is null for the second brand and publicUrlFor() is brand-blind, so ${which} links to the default brand's document (0104_brands.sql: "terms_url null renders Marley terms until gate 15 ships the unified brand-neutral document"). mustOccur is the retirement trigger — when gate 15 lands, this exemption goes dead and this spec FAILS telling you to delete it.`,
});

// ------------------------------------------------------------- the scanner

/**
 * One page reduced to what a person can perceive.
 *
 * `<script>` is REMOVED, and that is load-bearing rather than tidying. The RSC
 * flight payload is split across `self.__next_f.push(...)` calls at arbitrary
 * byte boundaries, so a literal can be cut in half between two script tags:
 * scanning it produces false negatives (a real leak, invisible) and false
 * positives (an exemption that "stopped occurring" because it was chopped).
 * Everything it carries that a customer can perceive is in the DOM anyway, read
 * AFTER hydration, so nothing is lost by dropping it. `<style>`/`<link>` go for
 * the same reason at lower stakes: stylesheet text and chunk URLs are build
 * artefacts, not copy.
 */
async function captureSurface(page: Page) {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    for (const node of Array.from(clone.querySelectorAll("script, style, noscript, link"))) {
      node.remove();
    }
    return { html: clone.outerHTML, text: document.body.innerText };
  });
}

/**
 * Entity-decode the handful of escapes the DOM serialiser introduces, then
 * flatten every whitespace run to one space.
 *
 * Flattening is what makes `"01747 637070"` match a number the markup happened
 * to wrap across a line, and `&nbsp;` decoding is what makes it match one typed
 * with a non-breaking space. Both are shapes a real leak takes; neither should
 * be able to hide behind formatting.
 */
function flatten(raw: string): string {
  return raw
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(new RegExp("[\\s\\u00a0]+", "g"), " ");
}

/** Enough context around a hit to recognise it without opening the page. */
function excerpt(haystack: string, needle: string, ci: boolean): string {
  const hay = ci ? haystack.toLowerCase() : haystack;
  const at_ = hay.indexOf(ci ? needle.toLowerCase() : needle);
  if (at_ === -1) return "(not located — reported by the detector on a different pass)";
  return "…" + haystack.slice(Math.max(0, at_ - 80), at_ + needle.length + 80).trim() + "…";
}

interface Stripped {
  content: string;
  counts: Map<string, number>;
}

/** Remove every permitted occurrence, counting each so a dead one can be caught. */
function stripPermitted(content: string, permitted: Permitted[]): Stripped {
  const counts = new Map<string, number>();
  let out = content;
  for (const entry of permitted) {
    if (!entry.text.trim()) {
      throw new Error(
        `Permitted-occurrence entry has an EMPTY string (reason: ${entry.reason}). An empty exemption would strip nothing and hide that it strips nothing.`,
      );
    }
    const parts = out.split(entry.text);
    counts.set(entry.text, Math.max(counts.get(entry.text) ?? 0, parts.length - 1));
    out = parts.join(" [permitted] ");
  }
  return { content: out, counts };
}

interface LeakHit {
  literal: string;
  where: "rendered text" | "rendered markup";
  context: string;
}

/**
 * Scan one captured page for one direction's literals.
 *
 * The DETECTOR is the source scan's own `findLeaksInContent`, not a
 * re-implementation: case-sensitivity per literal lives in one place, and a
 * change to the matching rules reaches both halves at once.
 */
function scanCaptured(
  captured: { html: string; text: string },
  literals: typeof FORBIDDEN,
  permitted: Permitted[],
): { hits: LeakHit[]; counts: Map<string, number>; textChars: number } {
  const wanted = new Set(literals.map((l) => l.literal));
  const hits: LeakHit[] = [];
  const counts = new Map<string, number>();
  let textChars = 0;

  for (const [where, raw] of [
    ["rendered text", captured.text],
    ["rendered markup", captured.html],
  ] as const) {
    const flat = flatten(raw);
    const { content, counts: seen } = stripPermitted(flat, permitted);
    for (const [text, n] of seen) counts.set(text, Math.max(counts.get(text) ?? 0, n));
    // The did-it-render precondition counts the TEXT only. Markup is thousands
    // of characters on any Next.js response — a not-found card included — so a
    // combined total can never fall below a threshold and the guard would be
    // inert while advertising itself as one of this file's loud preconditions.
    if (where === "rendered text") textChars = content.trim().length;
    for (const finding of findLeaksInContent(content, where)) {
      if (!wanted.has(finding.literal)) continue;
      if (hits.some((h) => h.literal === finding.literal && h.where === where)) continue;
      const rule = literals.find((l) => l.literal === finding.literal);
      hits.push({ literal: finding.literal, where, context: excerpt(content, finding.literal, !!rule?.ci) });
    }
  }
  return { hits, counts, textChars };
}

/** The rendered text a person can read, flattened — the did-it-render measure
 *  for the group surfaces, which run no literal scan. */
function renderedTextChars(captured: { text: string }): number {
  return flatten(captured.text).trim().length;
}

// ------------------------------------------------------------------- fixtures

interface BrandRow {
  slug: string;
  name: string;
  group_line: string;
  legal_line: string;
  phone: string | null;
  colour_primary: string | null;
  colour_accent: string | null;
  terms_url: string | null;
  active: boolean;
}

/**
 * Rows this run has created, recorded AS EACH ONE LANDS.
 *
 * Not a value returned by `seed()`, and that is the whole point. A returned
 * fixture is assigned only after the LAST insert, so a seed that throws
 * part-way leaves the teardown holding `null` — it deletes nothing, and the
 * read-back that is this file's stated evidence of a clean exit never runs.
 * With the ids accumulated here, a partial seed tears down exactly as far as it
 * got and still proves it.
 */
interface Created {
  clientIds: string[];
  leadIds: string[];
  siteIds: string[];
  unitIds: string[];
  letIds: string[];
}

const created: Created = { clientIds: [], leadIds: [], siteIds: [], unitIds: [], letIds: [] };

async function readSecondBrand(): Promise<BrandRow> {
  const { data, error } = await adminClient()
    .from("brands")
    .select("slug, name, group_line, legal_line, phone, colour_primary, colour_accent, terms_url, active")
    .eq("slug", SECOND_BRAND)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Reading the '${SECOND_BRAND}' brands row FAILED: ${error.message}. The rendered brand-leak scan cannot report "clean" on a page it could not resolve a brand for.`,
    );
  }
  if (!data) {
    throw new Error(
      `No '${SECOND_BRAND}' row in brands — migration 0104_brands.sql has not been applied to this target. Every seeded record would fall back to the DEFAULT brand and this scan would be checking the wrong pages.`,
    );
  }
  const row = data as BrandRow;
  if (!row.active) {
    throw new Error(
      `brands.${SECOND_BRAND}.active is FALSE on this target. Staging is flipped active by hand after 0104 applies (and the parity project restores it in afterAll) — an inactive row here means either that flip never happened or a parity teardown failed, and neither is an environment this check may report clean against.`,
    );
  }
  if (!(row.phone ?? "").trim()) {
    throw new Error(
      `brands.${SECOND_BRAND}.phone is empty, so pageTheme() refuses to render its customer pages by design (lib/brand-page-theme.ts). Every surface below would 500. Set a phone in Settings › Brands.`,
    );
  }
  if (!row.group_line.trim()) {
    throw new Error(
      `brands.${SECOND_BRAND}.group_line is empty. PRD §2 requires the group mark wherever a non-default brand's logo appears — this is a live brand-correctness defect, not a fixture problem.`,
    );
  }
  return row;
}

async function seed(): Promise<void> {
  const sb = adminClient();

  const client = async (what: string) => {
    const { data, error } = await sb
      .from("clients")
      .insert({ display_name: `${RUN_MARKER} ${what}`, postcode_home: "DT11 7AA", notes: RUN_MARKER })
      .select("id")
      .single();
    if (error) throw new Error(`seed client (${what}): ${error.message}`);
    created.clientIds.push(data.id as string);
    return data.id as string;
  };

  const lead = async (clientId: string, what: string) => {
    const { data, error } = await sb
      .from("leads")
      .insert({
        client_id: clientId,
        brand: SECOND_BRAND,
        status: "quoted",
        entry_channel: "manual",
        source_system: "marley_ops",
        name: `${RUN_MARKER} ${what}`,
        phone: "07700900000",
        email: "brand-leak-rendered@e2e.test",
        from_address: "1 Uplands Way, Blandford Forum",
        from_postcode: "DT11 7AA",
        to_address: "2 Sample Road, Gillingham",
        to_postcode: "SP8 4AB",
        property_size: "2 bedroom",
        media_consent: "unset",
        notes: RUN_MARKER,
      })
      .select("id")
      .single();
    if (error) throw new Error(`seed lead (${what}): ${error.message}`);
    created.leadIds.push(data.id as string);
    return data.id as string;
  };

  // /q — a SENT second-brand quote, 21 days out (outside the T-7 collapse) and
  // emailed yesterday (inside the 30-day validity), so the page renders the
  // ordinary residential accept state rather than a not-found or expired card.
  const quoteClientId = await client("Quote Client");
  const quoteLeadId = await lead(quoteClientId, "Quote Lead");
  const { error: qErr } = await sb.from("quotes").insert({
    quote_ref: QUOTE_REF,
    client_id: quoteClientId,
    lead_id: quoteLeadId,
    brand: SECOND_BRAND,
    customer_name: `${RUN_MARKER} Quote Lead`,
    customer_email: "brand-leak-rendered@e2e.test",
    customer_phone: "07700900000",
    subtotal: 1500,
    grand_total: 1500,
    status: "sent",
    moving_date: at(21).slice(0, 10),
    deposit_amount: 100,
    accept_token: TOKENS.quote,
    email_sent_at: at(-1),
    collect_addr: "1 Uplands Way, Blandford Forum, DT11 7AA",
    dest_addr: "2 Sample Road, Gillingham, SP8 4AB",
    vat_enabled: true,
    breakdown: { vehicle: "1luton", totalMiles: 20 },
    state_blob: { seeded: RUN_MARKER },
  });
  if (qErr) throw new Error(`seed quote: ${qErr.message}`);

  // /cv — a cubic survey hanging off a second-brand lead (the survey has no
  // brand of its own; the page reads `leads(brand)`).
  const cubicClientId = await client("Cubic Client");
  const cubicLeadId = await lead(cubicClientId, "Cubic Lead");
  const { error: cErr } = await sb.from("cubic_surveys").insert({
    lead_id: cubicLeadId,
    client_id: cubicClientId,
    status: "draft",
    items: [],
    customer_notes: "",
    notes: RUN_MARKER,
    share_token: TOKENS.cubic,
  });
  if (cErr) throw new Error(`seed cubic survey: ${cErr.message}`);

  // /s — an OPEN, UNSIGNED second-brand storage let. Unsigned matters: the
  // signed branch renders a receipt card instead of the agreement, and the
  // gate-15 storage-terms link lives in the unsigned branch.
  const storageClientId = await client("Storage Client");
  const { data: site, error: sErr } = await sb
    .from("storage_sites")
    .insert({
      name: `${RUN_MARKER} Site`,
      address: "Uplands Business Park, Blandford Forum, DT11 7UZ",
      is_active: true,
      notes: RUN_MARKER,
    })
    .select("id")
    .single();
  if (sErr) throw new Error(`seed storage site: ${sErr.message}`);
  created.siteIds.push(site.id as string);
  const { data: unit, error: uErr } = await sb
    .from("storage_units")
    .insert({
      site_id: site.id,
      code: `E2E-BL-${RUN}`,
      name: "Crate 1",
      unit_type: "crate_250",
      size_cuft: 250,
      is_active: true,
      notes: RUN_MARKER,
    })
    .select("id")
    .single();
  if (uErr) throw new Error(`seed storage unit: ${uErr.message}`);
  created.unitIds.push(unit.id as string);
  const { data: let_, error: lErr } = await sb
    .from("storage_lets")
    .insert({
      client_id: storageClientId,
      unit_id: unit.id,
      brand: SECOND_BRAND,
      start_date: at(0).slice(0, 10),
      rate: 25,
      rate_period: "week",
      sign_token: TOKENS.storage,
      notes: RUN_MARKER,
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed storage let: ${lErr.message}`);
  created.letIds.push(let_.id as string);
}

/** Every table this spec writes a `notes` marker into, deepest FK first. */
const MARKED_TABLES = [
  "storage_lets",
  "storage_units",
  "storage_sites",
  "cubic_surveys",
  "leads",
  "clients",
] as const;

/**
 * One level of an FK chain: rows that must ALL be gone before the level below
 * them may be deleted.
 */
interface DeleteLevel {
  /** What deleting the level below anyway would do to this level's leftovers. */
  orphanRisk: string;
  /** `run` resolves to the delete's error, or null when it deleted. */
  steps: Array<{ label: string; run: () => Promise<{ message: string } | null> }>;
}

/**
 * FK-ordered teardown that THROWS.
 *
 * Children before parents, and every delete's error is inspected — `#71` is the
 * standing lesson here: a swallowed `23503` leaked a marker set into staging on
 * every CI run, and the reports said the cleanup was clean. A teardown that
 * cannot prove it deleted is a teardown that did not.
 *
 * It runs off `created` (filled as each insert lands) UNIONED with a read of
 * this run's marker, so it works after a PARTIAL seed — the case that used to
 * skip the whole thing, leaking rows and skipping the read-back with it — and
 * also catches a row whose insert succeeded while the id came back unusable.
 * The read-back is scoped to THIS run's marker: a count over the shared prefix
 * would be tripped by a concurrent run's live fixtures, which is a different
 * fact and not one this teardown may report as its own dirt. Rows an earlier
 * killed process left behind are reclaimed by `scripts/seed-e2e.mjs`'s
 * `ilike('E2E %')` sweep instead, which is why every name carries that prefix.
 *
 * ## Recording a child's failure is not enough — the PARENT must not go
 *
 * Inspecting every error and carrying on was still wrong, because two of these
 * FKs are `on delete set null` rather than restrict. Deleting the parent after
 * its child delete failed does not fail; it SUCCEEDS, and nulls the only column
 * that could ever find the child again:
 *
 *   - `cubic_surveys.lead_id` (0029) — the survey survives with a NULL lead, so
 *     it falls outside `scripts/seed-e2e.mjs`'s sweep, which reaches surveys
 *     THROUGH their `ilike('E2E %')` leads. Nothing else looks for it.
 *   - `signatures.storage_let_id` (0027) — worse: `signatures` has no `notes`
 *     column and no name, so a signature orphaned from its let is beyond every
 *     sweep there is, including this file's own marker read-back.
 *
 * Either way the thrown message named the child's error while the read-back
 * counted zero, so the report said one delete failed and the mess was cleaned.
 * So a level whose delete failed STOPS the chain: the parents are left in
 * place, still pointing at their children, where the `E2E ` prefix sweep can
 * reclaim the lot on the next reseed. The failure message says exactly that —
 * which rows were not deleted, and that leaving them is the deliberate choice.
 */
async function teardown(): Promise<void> {
  // No credentials → `seed()` never reached the database, so there is nothing
  // to delete and nothing that could be read back. (In CI `beforeAll` has
  // already thrown for this; outside CI the whole file is skipped.)
  if (!E2E_DB_READY) return;
  const sb = adminClient();
  const failures: string[] = [];

  /**
   * Run one FK chain child-first, stopping at the first level that failed.
   *
   * The steps of a level are siblings and all run; the levels below it do not
   * run at all, because deleting a parent whose child survived is what turns a
   * recoverable mess into an unreachable one (see the header).
   */
  const deleteChain = async (levels: DeleteLevel[]): Promise<void> => {
    for (const [i, level] of levels.entries()) {
      const failed: string[] = [];
      for (const { label, run } of level.steps) {
        const error = await run();
        if (error) {
          failures.push(`${label}: ${error.message}`);
          failed.push(label);
        }
      }
      if (failed.length === 0) continue;
      const notRun = levels.slice(i + 1).flatMap((l) => l.steps.map((s) => s.label));
      if (notRun.length > 0) {
        failures.push(
          `NOT deleted, deliberately — ${notRun.join(", ")}: the ${failed.join(" and ")} delete above failed, and these are their PARENT rows. ${level.orphanRisk} They are left ATTACHED to their children instead, where the ilike('E2E %') sweep in scripts/seed-e2e.mjs still reaches the whole set on the next reseed`,
        );
      }
      return;
    }
  };

  /** Ids recorded during the seed, plus any row still carrying this run's marker. */
  const idsFor = async (table: string, recorded: string[]): Promise<string[]> => {
    const { data, error } = await sb.from(table).select("id").eq("notes", RUN_MARKER);
    if (error) {
      failures.push(`resolving ${table} rows to delete: ${error.message}`);
      return [...new Set(recorded)];
    }
    return [...new Set([...recorded, ...(data ?? []).map((r) => r.id as string)])];
  };

  const letIds = await idsFor("storage_lets", created.letIds);
  const unitIds = await idsFor("storage_units", created.unitIds);
  const siteIds = await idsFor("storage_sites", created.siteIds);
  const leadIds = await idsFor("leads", created.leadIds);
  const clientIds = await idsFor("clients", created.clientIds);

  // Storage: signature → let → unit → site.
  await deleteChain([
    {
      orphanRisk:
        "signatures.storage_let_id is `on delete set null` (0027), so deleting the let would leave the signature row with a NULL let — and `signatures` carries no notes column and no E2E name, which puts it beyond every sweep there is, this teardown's own marker read-back included.",
      steps: letIds.length
        ? [
            {
              label: "signatures (storage)",
              run: async () => (await sb.from("signatures").delete().in("storage_let_id", letIds)).error,
            },
          ]
        : [],
    },
    {
      orphanRisk:
        "storage_lets.unit_id is a plain restrict FK (0021), so the deletes below would fail with 23503 anyway — reported once here rather than as two more errors that say nothing new.",
      steps: letIds.length
        ? [
            {
              label: "storage_lets",
              run: async () => (await sb.from("storage_lets").delete().in("id", letIds)).error,
            },
          ]
        : [],
    },
    {
      orphanRisk: "storage_units.site_id is a restrict FK (0021), so the site delete below would fail anyway.",
      steps: unitIds.length
        ? [
            {
              label: "storage_units",
              run: async () => (await sb.from("storage_units").delete().in("id", unitIds)).error,
            },
          ]
        : [],
    },
    {
      orphanRisk: "nothing else in this fixture set references a storage site — this is the end of the chain.",
      steps: siteIds.length
        ? [
            {
              label: "storage_sites",
              run: async () => (await sb.from("storage_sites").delete().in("id", siteIds)).error,
            },
          ]
        : [],
    },
  ]);

  // Leads: everything hanging off the lead, then the lead, then the client.
  await deleteChain([
    {
      orphanRisk:
        "cubic_surveys.lead_id is `on delete set null` (0029), so deleting the lead would leave the survey behind with a NULL lead — outside scripts/seed-e2e.mjs's sweep, which reaches surveys THROUGH their `ilike('E2E %')` leads and so would never see it again. (quotes.lead_id and activities.lead_id are plain restrict FKs, 0001, and would have failed loudly instead.)",
      steps: leadIds.length
        ? [
            {
              label: "cubic_surveys",
              run: async () => (await sb.from("cubic_surveys").delete().in("lead_id", leadIds)).error,
            },
            {
              label: "activities",
              run: async () => (await sb.from("activities").delete().in("lead_id", leadIds)).error,
            },
            {
              label: "quotes",
              run: async () => (await sb.from("quotes").delete().in("lead_id", leadIds)).error,
            },
          ]
        : [],
    },
    {
      orphanRisk:
        "leads.client_id is `not null references clients(id)` (0001), a restrict FK, so the client delete below would fail with 23503 anyway.",
      steps: leadIds.length
        ? [{ label: "leads", run: async () => (await sb.from("leads").delete().in("id", leadIds)).error }]
        : [],
    },
    {
      orphanRisk: "nothing else in this fixture set references a client — this is the end of the chain.",
      steps: clientIds.length
        ? [{ label: "clients", run: async () => (await sb.from("clients").delete().in("id", clientIds)).error }]
        : [],
    },
  ]);

  // Read back rather than trust the deletes — the count is the evidence, and it
  // runs whether the seed completed, failed part-way, or never inserted a row.
  for (const table of MARKED_TABLES) {
    const { count, error } = await sb
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("notes", RUN_MARKER);
    if (error) failures.push(`verifying ${table} cleanup: ${error.message}`);
    else if (count) failures.push(`${count} ${table} row(s) marked "${RUN_MARKER}" survived the delete`);
  }
  // The quote carries no notes column — its unique ref is the handle.
  const { count: quotes, error: quoteErr } = await sb
    .from("quotes")
    .select("*", { count: "exact", head: true })
    .eq("quote_ref", QUOTE_REF);
  if (quoteErr) failures.push(`verifying quotes cleanup: ${quoteErr.message}`);
  else if (quotes) failures.push(`quote ${QUOTE_REF} survived the delete`);

  if (failures.length) {
    throw new Error(
      `brand-leak (rendered) teardown FAILED — staging is now dirty (the next \`node scripts/seed-e2e.mjs\` sweeps "${MARKER} …" rows, but fix the cause):\n  ${failures.join("\n  ")}`,
    );
  }
}

// ---------------------------------------------------------------- the surfaces

/**
 * A state this route also serves at HTTP 200, named so the failure says which
 * one arrived instead of "the expected text was not visible".
 */
interface Refusal {
  /** Copy unique to that state. No `g` flag — `.test` would be stateful. */
  pattern: RegExp;
  /** What actually happened, and what to do about it. */
  why: string;
}

interface Surface {
  label: string;
  path: string;
  /** Copy that proves the EXPECTED state rendered, not a not-found card. */
  expect: RegExp;
  /** The 200-with-an-error-card states this route can serve instead. */
  refuse?: Refusal[];
  permitted: (row: BrandRow) => Permitted[];
}

const SECOND_BRAND_SURFACES: Surface[] = [
  {
    label: "/q (accept and pay — brand from the quote)",
    path: `/q/${TOKENS.quote}`,
    expect: /Your removal quote/i,
    permitted: (row) => [groupMark(row), legalEntity, gate15(TERMS_URL, "the /q terms link"), appOrigin],
  },
  {
    label: "/s (storage agreement — brand from the let)",
    path: `/s/${TOKENS.storage}`,
    expect: /Storage agreement/i,
    permitted: (row) => [
      groupMark(row),
      legalEntity,
      gate15(STORAGE_TERMS_URL, "the /s storage-terms link"),
      appOrigin,
    ],
  },
  {
    label: "/cv (customer cubic survey — brand from the lead)",
    path: `/cv/${TOKENS.cubic}`,
    expect: /What's moving/i,
    permitted: (row) => [groupMark(row), legalEntity, appOrigin],
  },
];

/** The same three routes carrying DEFAULT-brand records, for the reverse pass. */
const DEFAULT_BRAND_SURFACES: Surface[] = [
  {
    label: "/q (default-brand quote)",
    path: `/q/${SEED.sentQuote.acceptToken}`,
    // The seeded quote is consumed by customer.spec.ts's accept leg on a full
    // run, so this may legitimately be the sent screen OR the pay screen. Both
    // are default-brand pages and both must be free of the other brand.
    expect: /Your removal quote|deposit to secure your date|Pay by bank transfer/i,
    permitted: () => [],
  },
  {
    label: "/s (default-brand storage let)",
    path: `/s/${SEED.storageAgreement.signToken}`,
    expect: /Storage agreement/i,
    permitted: () => [],
  },
  {
    label: "/cv (default-brand cubic survey)",
    path: `/cv/${SEED.cubicSurvey.shareToken}`,
    expect: /What's moving|All done/i,
    permitted: () => [],
  },
];

interface GroupSurface {
  label: string;
  path: string;
  /** Copy that appears ONLY on the real rendered surface. */
  expect: RegExp;
  refuse: Refusal[];
}

/**
 * Group surfaces (PRD §4) — see the test body for what is and is not asserted.
 *
 * Both routes serve an error card at HTTP 200 through the SAME shell, carrying
 * the same neutral charcoal accent this test asserts, so status + colour alone
 * cannot tell a rendered sheet from a dead one. Hence an expected-state regex
 * and a named refusal per failure state, exactly as the two record-surface
 * passes have (`expect` + `getByText`). The strings below were chosen to
 * discriminate: `/join`'s dead-link card says "…sent this to join the crew…",
 * so the heading "Join the crew" is NOT a usable marker case-insensitively —
 * the form's own instruction line is.
 */
const GROUP_SURFACES: GroupSurface[] = [
  {
    label: "/sheet (crew day sheet)",
    path: `/sheet/${SEED.daySheet.token}`,
    // The footer of the loaded sheet. Neither Notice card carries it.
    expect: /This link opens without signing in/i,
    refuse: [
      {
        pattern: /This job sheet has expired/i,
        why: "the seeded day sheet's work_date is more than STALE_DAYS=3 days old, so app/sheet/[token]/page.tsx served its expired Notice — at 200, in the same charcoal theme, which is why colour alone cannot tell. The seed dates it TOMORROW: re-run `node scripts/seed-e2e.mjs` against this target before reading anything into this run. This is a FAILURE and not a skip on purpose: a group pass that greened over the expired card would report colour coverage of a sheet it never saw",
      },
      {
        pattern: /We can't load your sheet right now/i,
        why: "assembleDaySheets threw TWICE for this work_date, so the page served its call-the-office Notice (again at 200, same theme). That is a real defect on a crew surface — check the server log for '[crew-sheet] day assembly failed twice'",
      },
    ],
  },
  {
    label: "/join (crew sign-up)",
    path: `/join/${SEED.joinApplicant.token}`,
    // The live form's instruction line — absent from DeadLinkCard.
    expect: /Fill in your details below/i,
    refuse: [
      {
        pattern: /This link isn't active/i,
        why: "the /join token did not match business_settings.staff_onboard_token, or staff_onboard_enabled is false, so the page served DeadLinkCard — at 200, through the same Shell and the same charcoal accent. The seed sets both unconditionally: re-run `node scripts/seed-e2e.mjs`",
      },
    ],
  },
];

/**
 * Refuse a 200 that is one of this route's known error states, by name.
 *
 * Runs BEFORE the expected-state assertion so the failure says which card
 * arrived and what to do, rather than a bare "expected text was not visible"
 * timeout that reads like a flake.
 */
function refuseKnownErrorStates(label: string, text: string, refusals: Refusal[]): void {
  for (const { pattern, why } of refusals) {
    if (pattern.test(text)) {
      throw new Error(`${label} answered 200 but rendered an ERROR state, not the surface under test — ${why}.`);
    }
  }
}

/** The inline `--color-mm-red` override, and its computed value. */
async function readAccent(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[style*="--color-mm-red"]');
    if (!el) return null;
    return getComputedStyle(el).getPropertyValue("--color-mm-red").trim().toLowerCase();
  });
}

// --------------------------------------------------------------------- tests

test.describe("Brand-leak scan — rendered pages (PRD §6.4, the half a source grep cannot do)", () => {
  let brandRow: BrandRow | null = null;

  /** The resolved second brand, or a loud refusal — never a silent default. */
  const brand = (): BrandRow => {
    if (!brandRow) {
      throw new Error(
        "the second brand was never resolved, so nothing below can be reported as checked (beforeAll did not complete).",
      );
    }
    return brandRow;
  };

  test.beforeAll(async () => {
    if (!E2E_DB_READY) {
      throw new Error(
        "brand-leak (rendered) is running in CI with no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. The e2e job exports both, so this is a JOB MISCONFIGURATION — and a brand-leak check that cannot seed a second-brand record must FAIL, never quietly pass having visited nothing.",
      );
    }
    brandRow = await readSecondBrand();
    await seed();
  });

  // Runs even when `seed()` threw part-way: `created` holds whatever landed, so
  // a partial seed is torn down and its read-back still executes.
  test.afterAll(async () => {
    await teardown();
  });

  test("the literal lists are real and correctly directed", async () => {
    // The exclusion in the header is only an exclusion while the literal exists.
    expect(
      FORBIDDEN.some((f) => f.literal === MM_RED),
      `"${MM_RED}" is no longer in FORBIDDEN, so this spec's deliberate exclusion of it now exempts nothing. Either restore it in scripts/brand-leak-literals.mjs or delete the exclusion and its rationale from this file's header.`,
    ).toBe(true);

    // A scan whose literal list filtered to nothing must fail, not report clean.
    expect(
      literalsFor("marley").length,
      "no default-brand literals to scan a second-brand page for — the direction filter matched nothing",
    ).toBeGreaterThan(0);
    expect(
      literalsFor(SECOND_BRAND).length,
      "no second-brand literals to scan a default-brand page for — the direction filter matched nothing",
    ).toBeGreaterThan(0);
  });

  test("no default-brand literal reaches a second-brand page", async ({ page }) => {
    const literals = literalsFor("marley");
    const visited: string[] = [];

    for (const surface of SECOND_BRAND_SURFACES) {
      await step(`${surface.label} carries no default-brand identity`, page, async () => {
        const res = await page.goto(surface.path);
        expect(
          res?.status(),
          `${surface.label} at ${surface.path} did not answer 200 — a brand-leak check cannot report clean on a page it never rendered.`,
        ).toBe(200);
        await page.waitForLoadState("networkidle");

        // Proof the SECOND BRAND's page rendered, not a not-found card wearing
        // the same theme: its own name, and the state-specific copy.
        await expect(page.getByText(brand().name, { exact: false }).first()).toBeVisible();
        await expect(page.getByText(surface.expect).first()).toBeVisible();

        const captured = await captureSurface(page);
        refuseKnownErrorStates(surface.label, flatten(captured.text), surface.refuse ?? []);
        const permitted = surface.permitted(brand());
        const { hits, counts, textChars } = scanCaptured(captured, literals, permitted);

        expect(
          textChars,
          `${surface.label} rendered almost no TEXT (${textChars} chars of body copy) — the page did not render, so this pass proves nothing. Markup length is deliberately not counted here: every Next.js response carries thousands of characters of it, so a combined measure can never fall below a threshold.`,
        ).toBeGreaterThan(MIN_RENDERED_TEXT);

        // The dead-allow rule, borrowed from the source scan: an exemption that
        // no longer fires has outlived its justification and must be deleted.
        for (const entry of permitted.filter((p) => p.mustOccur)) {
          expect(
            counts.get(entry.text) ?? 0,
            `EXPECTED occurrence missing on ${surface.label}: "${entry.text}" was exempted here on these grounds — ${entry.reason} — and it no longer occurs. Either the page regressed (the group mark is REQUIRED by PRD §2) or the exemption is now dead and must be deleted from this spec.`,
          ).toBeGreaterThan(0);
        }

        expect(
          hits.map((h) => `${h.literal} in the ${h.where}: ${h.context}`),
          `BRAND LEAK on ${surface.label} — a default-brand literal reached a second-brand customer's screen. The source grep cannot see this: the value arrived through a token, a database row or a helper outside the manifest.`,
        ).toEqual([]);

        // The colour half — the thing only a rendered check can assert. gate 16
        // re-points --color-mm-red rather than replacing the utility classes, so
        // the classes surviving is correct and the COMPUTED value is the fact.
        const accent = await readAccent(page);
        const wanted = expectedAccent(brand());
        expect(
          accent,
          `${surface.label} has no inline --color-mm-red override, so every mm-red utility on it is still painting the DEFAULT brand's red. That is a brand leak the source grep is structurally blind to (gate 16's mechanism is exactly this override).`,
        ).not.toBeNull();
        expect(
          accent,
          `${surface.label} renders the DEFAULT brand's red. The override exists but points at the wrong colour, which is a brand leak the source grep cannot see — the class names are identical either way.`,
        ).not.toBe(DEFAULT_ACCENT);
        expect(
          wanted,
          `the '${SECOND_BRAND}' row carries no colour on which white text is legible (colour_primary ${brand().colour_primary ?? "unset"}, colour_accent ${brand().colour_accent ?? "unset"}), so brandCtaColour returns null and pageTheme falls back to the DEFAULT brand's red on every one of this brand's pages. That is a live brand-correctness defect in the row, not a fixture problem — set a usable colour in Settings › Brands.`,
        ).not.toBeNull();
        // ONE expected colour, not "either of the brand's two". The rule
        // (lib/brand.ts brandCtaColour) rejects an accent white text cannot sit
        // on, which is exactly why this brand's yellow must never paint a CTA —
        // and accepting either colour would green the build in which that rule
        // had been deleted. The expectation is re-derived from the row here, so
        // deleting the rule turns this RED rather than moving with it.
        expect(
          accent,
          `${surface.label} renders accent ${accent}, but the brands row says its pages must render ${wanted} (colour_primary ${brand().colour_primary ?? "unset"}, colour_accent ${brand().colour_accent ?? "unset"}; the accent is preferred ONLY while white text on it clears WCAG 3:1). If ${accent} is this brand's colour_accent, the legibility rule in lib/brand.ts (brandCtaColour → whiteTextLegible) has been removed or bypassed and every CTA, border and hover state on this page is now white-on-${accent}.`,
        ).toBe(wanted);

        visited.push(surface.label);
      });
    }

    expect(
      visited.length,
      `the rendered brand-leak scan checked ${visited.length} of ${SECOND_BRAND_SURFACES.length} second-brand surfaces. A run that checked fewer than all of them has not done its job — "I checked nothing" must never render as "nothing to report".`,
    ).toBe(SECOND_BRAND_SURFACES.length);
  });

  test("no second-brand literal reaches a default-brand page", async ({ page }) => {
    const literals = literalsFor(SECOND_BRAND);
    const visited: string[] = [];

    for (const surface of DEFAULT_BRAND_SURFACES) {
      await step(`${surface.label} carries no second-brand identity`, page, async () => {
        const res = await page.goto(surface.path);
        expect(
          res?.status(),
          `${surface.label} at ${surface.path} did not answer 200 — reseed (scripts/seed-e2e.mjs) before reading anything into this run.`,
        ).toBe(200);
        await page.waitForLoadState("networkidle");
        await expect(page.getByText(surface.expect).first()).toBeVisible();

        const captured = await captureSurface(page);
        refuseKnownErrorStates(surface.label, flatten(captured.text), surface.refuse ?? []);
        // No permitted occurrences in this direction, deliberately: nothing
        // legitimate brings the second brand onto the default brand's page.
        const { hits, textChars } = scanCaptured(captured, literals, []);

        expect(
          textChars,
          `${surface.label} rendered almost no TEXT (${textChars} chars of body copy) — the page did not render, so this pass proves nothing.`,
        ).toBeGreaterThan(MIN_RENDERED_TEXT);
        expect(
          hits.map((h) => `${h.literal} in the ${h.where}: ${h.context}`),
          `BRAND LEAK on ${surface.label} — a second-brand literal reached a default-brand customer's screen.`,
        ).toEqual([]);

        // The §1 byte-parity invariant, observed rather than argued: the default
        // brand's theme carries no rootStyle, so a default-brand page must emit
        // no accent override at all — not one that happens to equal the red.
        expect(
          await readAccent(page),
          `${surface.label} emits an inline --color-mm-red override. The default brand's pages must render exactly the markup they do today (PRD §1 single-brand invariant); pageTheme returns rootStyle: undefined for it.`,
        ).toBeNull();

        visited.push(surface.label);
      });
    }

    expect(
      visited.length,
      `the reverse pass checked ${visited.length} of ${DEFAULT_BRAND_SURFACES.length} default-brand surfaces.`,
    ).toBe(DEFAULT_BRAND_SURFACES.length);
  });

  test("group surfaces are coloured as neither brand", async ({ page }) => {
    /*
     * `/sheet` and `/join` are GROUP surfaces (PRD §4): one shared crew across
     * every brand, so they take GROUP_PAGE_THEME.
     *
     * The literal scan is deliberately NOT run here, and that is a judgement
     * about what these pages ARE rather than a convenience. The group's identity
     * IS the operating company — GROUP_PAGE_THEME keeps the default brand's
     * name, legal line, phone and "Call Connor on" wording on purpose — so
     * default-brand literals are the page's own content, not a leak. In the
     * other direction, PRD §4 says a mixed-brand crew day carries a brand chip
     * per job block, so the second brand's NAME is legitimate here too. A
     * literal assertion in either direction would be asserting against the
     * design, which is worse than no assertion because it would read as one.
     *
     * What IS assertable is the one thing §4 actually promises: the accent is
     * neutral charcoal, so a crew day spanning brands is coloured as neither.
     *
     * That makes the expected-state assertion below load-bearing rather than
     * ceremonial. BOTH routes serve an error card at HTTP 200 through the very
     * same shell and the very same charcoal `rootStyle` — `/sheet` when the
     * day sheet is stale (STALE_DAYS=3) or the day fails to assemble twice,
     * `/join` when the token misses or the sign-up switch is off — so status
     * and colour together still cannot tell a rendered sheet from a dead link.
     * Without it this test greened having checked two error screens, which is
     * the "I could not check rendering as nothing to report" failure the rest
     * of this file exists to prevent.
     */
    const visited: string[] = [];
    for (const surface of GROUP_SURFACES) {
      await step(`${surface.label} renders the neutral group accent`, page, async () => {
        const res = await page.goto(surface.path);
        expect(
          res?.status(),
          `${surface.label} at ${surface.path} did not answer 200 — reseed (scripts/seed-e2e.mjs) before reading anything into this run.`,
        ).toBe(200);
        await page.waitForLoadState("networkidle");

        // The surface it claims to be, or a named refusal — never a 200 that
        // happens to be charcoal.
        const captured = await captureSurface(page);
        refuseKnownErrorStates(surface.label, flatten(captured.text), surface.refuse);
        await expect(page.getByText(surface.expect).first()).toBeVisible();
        const chars = renderedTextChars(captured);
        expect(
          chars,
          `${surface.label} rendered almost no TEXT (${chars} chars of body copy) — the page did not render, so the accent below proves nothing.`,
        ).toBeGreaterThan(MIN_RENDERED_TEXT);

        const accent = await readAccent(page);
        expect(
          accent,
          `${surface.label} emits no --color-mm-red override, so its mm-red utilities are still painting the default brand's red. A group surface must be neutral (PRD §4) — GROUP_PAGE_THEME sets the charcoal accent for exactly this reason.`,
        ).not.toBeNull();
        expect(
          accent,
          `${surface.label} renders accent ${accent}, not the neutral group charcoal. A crew day legitimately spans brands; colouring it as one claims something untrue about the other's jobs.`,
        ).toBe(GROUP_ACCENT);

        visited.push(surface.label);
      });
    }
    expect(visited.length, "a group-surface pass that visited nothing proves nothing").toBe(
      GROUP_SURFACES.length,
    );
  });
});
