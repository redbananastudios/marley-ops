/**
 * Reduce a raw inbound email body to just the customer's NEW message.
 *
 * When a customer replies, their client (Yahoo/Gmail/Outlook/Apple Mail) appends
 * the entire quoted original — for a Marley reply that's the whole fixed-price
 * quote email, a table-heavy HTML message that collapses into a "| | |" wall when
 * flattened to text. Forwarding it verbatim buried the one line that matters under
 * hundreds of characters of our own quote (Peter, 2026-08-02: "replies come across
 * unformatted and difficult to read").
 *
 * Design bias: UNDER-cut, never over-cut. Dropping a customer's booking/deposit
 * line is a lost job; leaving some quoted text is only untidy. Two quote styles:
 *
 *  - ">"-quoted (Gmail/Apple plain text): the customer's words are the NON-quoted
 *    lines, wherever they sit — top, bottom, or INTERLEAVED between our quoted
 *    questions. So we drop the ">" lines + the attribution line and keep the rest
 *    in order. (A non-">" quote continuation — a wrapped URL/footer — can leak as
 *    if the customer typed it; accepted, because the alternative risks dropping an
 *    interleaved answer, and the leak is our own text going to our own office.)
 *  - Not ">"-quoted (flattened Yahoo, or clients that top-post without markers):
 *    the reply sits ABOVE a strict attribution ("On <date> … <email> wrote:") — cut
 *    there to the end.
 *
 * ">" lines are only treated as quoting when there IS a real quote context (an
 * attribution or an Outlook header block); otherwise a customer's ">" bullet list
 * ("> 30 boxes / > a piano") is left intact. If trimming would leave nothing the
 * caller falls back to the raw body, so a message is never silently dropped.
 *
 * Pure + deterministic (unit-testable) and linear-time (no catastrophic backtracking
 * — the public inbound webhook feeds this untrusted content).
 */

const DOW = "Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?";
const MON =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

/**
 * The Gmail/Yahoo/Apple reply attribution: "On <weekday|day month> … <email> wrote:".
 * Requires a real date shape right after "On" AND an <email> in angle brackets before
 * "wrote:" — so it can't fire on a customer's "…park on the road … wrote". All quantifiers
 * are bounded so a long single line can't trigger catastrophic backtracking.
 */
const ATTRIBUTION = new RegExp(
  `\\bOn\\s+(?:(?:${DOW})|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MON}))\\b[^\\n]{0,220}?<[^\\n<>@]{1,64}@[^\\n<>]{1,255}>[^\\n]{0,30}?\\bwrote:`,
  "i",
);

/**
 * History markers anchored to LINE-START so they never match inline customer prose.
 * The Outlook header requires the full From → Sent/Date → Subject shape (Subject is
 * the tell): a customer listing "From: <addr>\nTo: <addr>\nDate: <date>" — no
 * Sent/Subject — is left intact.
 */
const LINE_MARKERS: RegExp[] = [
  /^[ \t]*-{2,}\s*Original Message\s*-{2,}/im, // Outlook / older clients
  /^[ \t]*From:[^\n]+\n[ \t]*(?:Sent|Date):[^\n]+(?:\n[ \t]*To:[^\n]+)?(?:\n[ \t]*Cc:[^\n]+)?\n[ \t]*Subject:/im,
  /^[ \t]*Begin forwarded message:/im, // Apple Mail forward
  // NB: a bare "_____" underscore divider is deliberately NOT a marker — Yahoo/Outlook
  // pair it with an "On … wrote:" attribution (already caught), whereas a customer who
  // underlines a header would otherwise lose everything below it. Under-cut, not over-cut.
];

/** Distinctive webmail footer — safe to strip inline (a customer won't type it). */
const YAHOO_TAGLINE = /\bYahoo Mail:[^\n]*/gi;
/**
 * Device/app signatures — stripped ONLY as a whole line, never mid-sentence, so
 * "I sent from my work email, please use this" is left alone.
 */
const LINE_TAGLINES: RegExp[] = [
  /^[ \t]*Sent from my [^\n]*$/gim,
  /^[ \t]*Get ?Outlook for i(?:OS|Android)[^\n]*$/gim,
  /^[ \t]*Sent from (?:Mail for Windows|Outlook)[^\n]*$/gim,
];

/** Everything before the earliest of these markers (each already matched, or not). */
function cutBeforeMarkers(text: string, markers: RegExp[]): string {
  let cut = text.length;
  for (const re of markers) {
    const m = text.match(re);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

export function extractReplyText(raw: string | null | undefined): string {
  const t = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) return "";

  const hasQuoteContext = ATTRIBUTION.test(t) || LINE_MARKERS.some((re) => re.test(t));
  const hasAngleQuotes = /^[ \t]*>/m.test(t);

  let out: string;
  if (!hasQuoteContext) {
    // No quote at all → keep everything, including a customer's own ">" bullets.
    out = t;
  } else if (hasAngleQuotes) {
    // ">"-quoted: keep the non-quoted lines (the customer's words, wherever they
    // sit) and drop the ">" lines + the attribution line. Interleaved-safe.
    out = t
      .split("\n")
      .filter((line) => !/^[ \t]*>/.test(line) && !ATTRIBUTION.test(line))
      .join("\n");
    // An Outlook header block isn't ">"-quoted — cut it if one is present.
    out = cutBeforeMarkers(out, LINE_MARKERS);
  } else {
    // Top-posted with an attribution/header but no ">" quoting (incl. flattened
    // Yahoo) → the reply is above the marker; cut to the end.
    out = cutBeforeMarkers(t, [ATTRIBUTION, ...LINE_MARKERS]);
  }

  // Strip client footers (Yahoo inline; others whole-line only).
  out = out.replace(YAHOO_TAGLINE, " ");
  for (const re of LINE_TAGLINES) out = out.replace(re, "");

  // Collapse HTML→text table pipe RUNS ("| | |") to a space. Anchored on a real
  // "|" (then more) so it never backtracks across a pipe-free whitespace run — a
  // lone "5 | 6" the customer typed is left alone.
  out = out.replace(/\|(?:[ \t]*\|)+/g, " ");

  // Tidy whitespace. Collapse space RUNS first (single greedy pass) so the later
  // trailing-space trim can't backtrack across a long run — a whitespace-padded
  // body from the public webhook must stay linear, not O(n²).
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return out;
}

/**
 * Flatten an HTML email body to plain text for the reply extractor. Inbound
 * replies are sometimes HTML-only (Gmail, iPhone Mail) with an EMPTY text part,
 * so a caller that only reads the text part loses the message entirely and the
 * office sees a "(open the forwarded copy)" placeholder (Priscilla Kong, MMR020,
 * 2026-08-03 — "I've accepted your quote and paid £100 deposit" was dropped).
 *
 * Quoted history lives in <blockquote> (Gmail/Apple Mail) — drop it here so the
 * flattened table "| | |" wall never reaches the caller. Any attribution line
 * ("On <date> … wrote:") that sits OUTSIDE the blockquote survives as text and
 * is handled by extractReplyText downstream, so feed the output through that.
 *
 * Linear-time (no catastrophic backtracking): every quantifier is bounded or
 * anchored, and whitespace runs are collapsed in one pass before the trailing
 * trim — this runs on untrusted inbound content from the public webhook.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"',
  apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  pound: "£", euro: "€", cent: "¢", yen: "¥", // money — matters in this domain
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  middot: "·", bull: "•", deg: "°",
};

export function htmlToText(html: string | null | undefined): string {
  const h = (html ?? "").replace(/\r\n?/g, "\n");
  if (!h) return "";
  return h
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, "\n") // quoted history
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // Numeric entities first, then named — so a literal "&amp;#163;" (rare double
    // encode) doesn't wrongly resolve to £.
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_, hex) => {
      const n = parseInt(hex, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/&#(\d{1,7});/g, (_, d) => {
      const n = Number(d);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
