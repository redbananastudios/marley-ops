import { describe, expect, it } from "vitest";
import { brandedEmailHtml } from "@/lib/comms/branded-shell";

/** The ad-hoc branded shell: HTML-escapes free-text copy, always carries the
 *  standard footer (VAT line), renders the CTA when given, and turns blank-line
 *  paragraphs into separate <p> blocks. */

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
