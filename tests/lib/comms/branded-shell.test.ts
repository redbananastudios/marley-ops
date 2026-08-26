import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";
import { mapBrand } from "@/lib/brand";

/** The ad-hoc branded shell: HTML-escapes free-text copy, always carries the
 *  standard footer (VAT line), renders the CTA when given, and turns blank-line
 *  paragraphs into separate <p> blocks. Multi-brand (PRD §3.5): the `brand`
 *  parameter swaps the chrome; marley/absent is byte-locked to the pre-brand
 *  output. */

/** The Pitmans row as seeded by migration 0104 (logo_url null until Phase 0). */
const pitmans = mapBrand({
  slug: "pitmans",
  name: "Pitmans Removals & Storage",
  short_name: "Pitmans",
  initial: "P",
  group_line: "Part of the Marley Group",
  legal_line:
    "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd. Company No. 15914266. VAT 520 2213 58.",
  ref_prefix: "PM",
  colour_primary: "#2B2B76",
  colour_accent: "#FFCC00",
  logo_url: null,
  email_domain: "pitmansremovals.co.uk",
  hello_from: "info@pitmansremovals.co.uk",
  accounts_from: "accounts@pitmansremovals.co.uk",
  reply_domain: "reply.pitmansremovals.co.uk",
  phone: "01258 858564",
  address:
    "Uplands Business Park, Blandford Heights, Shaftesbury Road, Blandford Forum, Dorset DT11 7UZ",
  website_url: "https://pitmansremovals.co.uk",
});

describe("brandedEmailHtml", () => {
  it("HTML-escapes interpolated text (greeting, headline, paragraphs) and the CTA url", () => {
    const html = brandedEmailHtml({
      preheader: "Preview <script> & more",
      greeting: "Jane <b>Smith</b>",
      headline: "A & B <tag>",
      paragraphs: ["Watch out for <script>alert(1)</script> & 5 < 6."],
      cta: { label: "Click <me> & go", url: 'https://example.com/x?a=1&b="2"' },
    });
    // No raw injected tags survive.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>Smith</b>");
    // Escaped forms are present.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Jane &lt;b&gt;Smith&lt;/b&gt;");
    expect(html).toContain("A &amp; B &lt;tag&gt;");
    // The CTA url is attribute-escaped (double-quote and ampersand).
    expect(html).toContain('href="https://example.com/x?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain("Click &lt;me&gt; &amp; go");
  });

  it("always includes the standard footer VAT line and the team sign-off", () => {
    const html = brandedEmailHtml({
      preheader: "hello",
      paragraphs: ["Just a note."],
    });
    expect(html).toContain("VAT 520 2213 58");
    expect(html).toContain("MarleyMoves Ltd");
    expect(html).toContain("Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX");
    expect(html).toContain("The Marley Moves Team");
    expect(html).toContain("https://marleymoves.co.uk/logo.png");
  });

  it("renders the red call button only when a cta is given", () => {
    const withCta = brandedEmailHtml({
      preheader: "p",
      paragraphs: ["Sign here."],
      cta: { label: "Review & sign", url: "https://ops.marleymoves.co.uk/s/tok" },
    });
    expect(withCta).toContain("https://ops.marleymoves.co.uk/s/tok");
    expect(withCta).toContain("Review &amp; sign");

    const noCta = brandedEmailHtml({ preheader: "p", paragraphs: ["No button here."] });
    expect(noCta).not.toContain("/s/tok");
    // No anchor styled as the red button (padding:17px 52px is the button's signature).
    expect(noCta).not.toContain("padding:17px 52px");
  });

  it("renders one <p> per paragraph", () => {
    const html = brandedEmailHtml({
      preheader: "p",
      paragraphs: ["First paragraph.", "Second paragraph.", "Third paragraph."],
    });
    // Each body paragraph is present as its own text.
    expect(html).toContain("First paragraph.");
    expect(html).toContain("Second paragraph.");
    expect(html).toContain("Third paragraph.");
    // Body paragraphs use the INK_SOFT paragraph style — count the occurrences.
    const bodyMatches = html.match(/font-size:14\.5px;color:#5A554F/g) ?? [];
    expect(bodyMatches.length).toBe(3);
  });

  it("converts single newlines inside a paragraph to <br>", () => {
    const html = brandedEmailHtml({
      preheader: "p",
      paragraphs: ["Line one\nLine two"],
    });
    expect(html).toContain("Line one<br>Line two");
  });
});

describe("brandedEmailHtml — multi-brand chrome (PRD §3.5)", () => {
  const input = {
    preheader: "Canonical lock",
    greeting: "Jane",
    headline: "Headline",
    paragraphs: ["First.", "Second\nline."],
    cta: { label: "Pay now", url: "https://ops.marleymoves.co.uk/q/tok" },
  };

  it("marley/absent is BYTE-IDENTICAL to the pre-brand shell (SHA-256 lock)", () => {
    // Hash computed from the pre-change implementation's output for `input`
    // (verified old-vs-new across an input matrix at gate 13). If this fails,
    // a live Marley email changed bytes — that is the headline property of the
    // multi-brand build; only update the hash for a DELIBERATE house-style
    // change, never to make a brand refactor pass.
    const locked = "ae4d978b19d695e1ffd3fa53c53135021b46b2963bc9ea9c86da719273032b57";
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    expect(sha(brandedEmailHtml(input))).toBe(locked);
    expect(sha(brandedEmailHtml({ ...input, brand: null }))).toBe(locked);
    const marleyRow = mapBrand({ slug: "marley", name: "Marley Moves", short_name: "Marley" });
    expect(sha(brandedEmailHtml({ ...input, brand: marleyRow }))).toBe(locked);
  });

  it("renders the Pitmans chrome: yellow header band, blue wordmark and CTA", () => {
    const html = brandedEmailHtml({ ...input, brand: pitmans });
    // Yellow band (accent fails the white-text WCAG rule → large flat area).
    expect(html).toContain('bgcolor="#FFCC00"');
    expect(html).toContain("background:#FFCC00");
    // No logo yet → wordmark in the primary blue on the band.
    expect(html).toContain("color:#2B2B76");
    expect(html).toContain("Pitmans Removals &amp; Storage</span>");
    // Buttons are the primary blue, never the yellow and never Marley red.
    expect(html).toContain('bgcolor="#2B2B76"');
    expect(html).toContain("background:#2B2B76");
    expect(html).not.toContain("#C03838");
  });

  it("carries the Pitmans footer identity and the group disclosure", () => {
    const html = brandedEmailHtml({ ...input, brand: pitmans });
    expect(html).toContain("Part of the Marley Group");
    expect(html).toContain("trading name of MarleyMoves Ltd");
    expect(html).toContain("Blandford Forum");
    expect(html).toContain('href="tel:01258858564"');
    expect(html).toContain("01258 858564");
    expect(html).toContain("info@pitmansremovals.co.uk");
    expect(html).toContain(">pitmansremovals.co.uk</a>");
    expect(html).toContain("The Pitmans Removals &amp; Storage Team");
    expect(html).toContain("<title>Pitmans Removals &amp; Storage</title>");
    // No Marley identity leaks into the brand surface…
    expect(html).not.toContain("The Marley Moves Team");
    expect(html).not.toContain("logo.png");
    expect(html).not.toContain("01747");
    expect(html).not.toContain("hello@marleymoves.co.uk");
    // …except the deliberate interim fallbacks: terms_url null renders
    // Marley's terms until gate 15 (migration 0104 note) and privacy is the
    // entity-level policy (no per-brand field yet).
    expect(html).toContain("https://marleymoves.co.uk/terms-conditions");
    expect(html).toContain("https://marleymoves.co.uk/privacy-policy");
  });

  it("a brand with a logo renders it with the brand name as alt", () => {
    const html = brandedEmailHtml({
      ...input,
      brand: { ...pitmans, logoUrl: "https://pitmansremovals.co.uk/logo.png" },
    });
    expect(html).toContain('src="https://pitmansremovals.co.uk/logo.png"');
    expect(html).toContain('alt="Pitmans Removals &amp; Storage"');
  });

  it("a dark accent keeps the plain white header (the diary WCAG rule, no slug switch)", () => {
    const html = brandedEmailHtml({
      ...input,
      brand: { ...pitmans, colourAccent: "#C03838", colourPrimary: "#1A1A1A" },
    });
    expect(html).not.toContain("bgcolor=\"#C03838\" style=\"padding:26px");
    expect(html).toContain("border-bottom:1px solid #EFECE7");
    // …and the accent, being white-text legible, becomes the CTA colour.
    expect(html).toContain('bgcolor="#C03838" style="border-radius:8px;"');
  });

  it("HTML-escapes brand-row fields (they are Settings-editable free text)", () => {
    const html = brandedEmailHtml({
      ...input,
      brand: { ...pitmans, name: 'Pit<mans> & "Co"', logoUrl: null },
    });
    expect(html).not.toContain("Pit<mans>");
    expect(html).toContain("Pit&lt;mans&gt; &amp;");
  });
});
