import { brandCtaColour, DEFAULT_BRAND, type Brand } from "@/lib/brand";

/**
 * Branded shell for ad-hoc (non-template) customer emails — a TypeScript port of
 * the house style in scripts/create-resend-templates.mjs (which is the canonical
 * source: white logo header, Montserrat, big light headline, red accent, and the
 * STANDARD_FOOTER with the VAT line + full address + insurance + Registered in
 * England & Wales). Every one-off email an operator composes in the panel goes
 * through here so it looks identical to the managed Resend templates.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): `brand` selects the shell chrome —
 * logo/wordmark header, CTA colour, sign-off and footer identity. With `brand`
 * absent or the marley row the output is BYTE-IDENTICAL to the single-brand
 * shell: the default chrome IS today's literal strings, never values read back
 * from the brands table. Other brands render from their row, falling back
 * per-field to the Marley literals (the operating company's registered details)
 * where a stub row has gaps — PRD §10.
 *
 * Pure server util — no React, no DOM. Returns an HTML string. UK English.
 * ALL interpolated text is HTML-escaped (URLs are attribute-escaped) — the copy
 * comes from a free-text compose box, so it must never be trusted raw.
 */

const LOGO_URL = "https://marleymoves.co.uk/logo.png";
const FONT_STACK = "'Montserrat','Segoe UI',Helvetica,Arial,sans-serif";
const FONT_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">';
const RED = "#C03838";
const INK = "#1A1A1A";
const INK_SOFT = "#5A554F";

/** HTML-escape text destined for element content. */
function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape text destined for a double-quoted attribute value (e.g. a CTA href). */
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

// Standard footer on EVERY email — kept in step with STANDARD_FOOTER in
// scripts/create-resend-templates.mjs. Legal name MarleyMoves Ltd (one word);
// the brand "Marley Moves" (space) stays in body copy + team sign-off.
const STANDARD_FOOTER = `  <tr><td style="padding:26px 36px;border-top:1px solid #EAE7E2;">
    <p style="margin:0;font-size:11px;line-height:1.85;color:#8A857E;text-align:center;">
      <strong style="color:#5A554F;">MarleyMoves Ltd</strong> &middot; Company No. 15914266 &middot; VAT 520 2213 58<br>
      Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX<br>
      <a href="tel:01747637070" style="color:#8A857E;text-decoration:none;">01747 637070</a> &middot; <a href="mailto:hello@marleymoves.co.uk" style="color:#8A857E;text-decoration:none;">hello@marleymoves.co.uk</a> &middot; <a href="https://marleymoves.co.uk" style="color:#8A857E;text-decoration:none;">marleymoves.co.uk</a><br>
      Fully insured: Public Liability up to &pound;2.5m &middot; Goods in Transit up to &pound;50k<br>
      Registered in England &amp; Wales &middot; <a href="https://marleymoves.co.uk/terms-conditions" style="color:#8A857E;text-decoration:underline;">Terms</a> &middot; <a href="https://marleymoves.co.uk/privacy-policy" style="color:#8A857E;text-decoration:underline;">Privacy</a>
    </p>
  </td></tr>`;

/** The shell chrome one brand contributes: everything outside the free copy. */
interface ShellChrome {
  /** <title> text and the header image alt. */
  title: string;
  /** Full header `<tr>` chunk (logo/wordmark, band when the brand takes one). */
  headerRow: string;
  /** CTA button colour. */
  ctaColour: string;
  /** Team sign-off line. */
  signOff: string;
  /** Full footer `<tr>` chunk (legal + group disclosure + contact links). */
  footerRow: string;
}

// The default chrome is TODAY'S literals, verbatim — the marley/absent path
// must never depend on the brands row round-tripping to the same bytes.
const MARLEY_CHROME: ShellChrome = {
  title: "Marley Moves",
  headerRow: `  <tr><td align="center" style="padding:34px 36px 22px;border-bottom:1px solid #EFECE7;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="200" style="display:block;margin:0 auto;height:auto;max-width:64%;border:0;outline:none;text-decoration:none;">
  </td></tr>`,
  ctaColour: RED,
  signOff: "The Marley Moves Team",
  footerRow: STANDARD_FOOTER,
};

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/** Build another brand's chrome from its row, Marley literals filling gaps. */
function brandChrome(brand: Brand): ShellChrome {
  const name = brand.name.trim() || "Marley Moves";
  const ctaColour = brandCtaColour(brand) ?? RED;

  // Header band — the same WCAG data rule as the diary (lib/brand.ts), no slug
  // switches: an accent white text is NOT legible on is a large-flat-area
  // colour (PRD §2/§10 — Pitmans yellow), so the header renders it as a full
  // band with the primary colour carrying the wordmark ("yellow blocks take
  // blue text"). A dark accent keeps the plain white header Marley uses.
  const accent = (brand.colourAccent ?? "").trim();
  const bandColour =
    HEX_COLOUR.test(accent) &&
    brandCtaColour({ colourPrimary: null, colourAccent: accent }) === null
      ? accent
      : null;
  const primary = (brand.colourPrimary ?? "").trim();
  const wordmarkColour = bandColour && HEX_COLOUR.test(primary) ? primary : INK;

  const headerInner = brand.logoUrl
    ? `<img src="${escAttr(brand.logoUrl)}" alt="${escAttr(name)}" width="200" style="display:block;margin:0 auto;height:auto;max-width:64%;border:0;outline:none;text-decoration:none;">`
    : `<span style="font-family:${FONT_STACK};font-size:23px;font-weight:700;letter-spacing:-0.01em;color:${wordmarkColour};">${esc(name)}</span>`;
  const headerRow = bandColour
    ? `  <tr><td align="center" bgcolor="${bandColour}" style="padding:26px 36px;background:${bandColour};">
    ${headerInner}
  </td></tr>`
    : `  <tr><td align="center" style="padding:34px 36px 22px;border-bottom:1px solid #EFECE7;">
    ${headerInner}
  </td></tr>`;

  // Footer identity from the row; the fallbacks are the operating company's
  // registered details (the same MarleyMoves Ltd every brand trades as).
  // terms_url null deliberately renders Marley's terms until gate 15 ships the
  // unified document (migration 0104 note); privacy is entity-level and has no
  // per-brand field yet, so it points at the company policy for every brand.
  const legalLine = brand.legalLine.trim() || "MarleyMoves Ltd · Company No. 15914266 · VAT 520 2213 58";
  const groupLine = brand.groupLine.trim();
  const address = (brand.address ?? "").trim() || "Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX";
  const phone = (brand.phone ?? "").trim() || "01747 637070";
  const telHref = "tel:" + phone.replace(/[^0-9+]/g, "");
  const email = (brand.helloFrom ?? "").trim() || "hello@marleymoves.co.uk";
  const website = ((brand.websiteUrl ?? "").trim() || "https://marleymoves.co.uk").replace(/\/+$/, "");
  const websiteLabel = website.replace(/^https?:\/\//, "");
  const termsUrl = (brand.termsUrl ?? "").trim() || "https://marleymoves.co.uk/terms-conditions";
  const privacyUrl = "https://marleymoves.co.uk/privacy-policy";

  const footerRow = `  <tr><td style="padding:26px 36px;border-top:1px solid #EAE7E2;">
    <p style="margin:0;font-size:11px;line-height:1.85;color:#8A857E;text-align:center;">
      ${groupLine ? `${esc(groupLine)}<br>
      ` : ""}<strong style="color:#5A554F;">${esc(legalLine)}</strong><br>
      ${esc(address)}<br>
      <a href="${escAttr(telHref)}" style="color:#8A857E;text-decoration:none;">${esc(phone)}</a> &middot; <a href="mailto:${escAttr(email)}" style="color:#8A857E;text-decoration:none;">${esc(email)}</a> &middot; <a href="${escAttr(website)}" style="color:#8A857E;text-decoration:none;">${esc(websiteLabel)}</a><br>
      Fully insured: Public Liability up to &pound;2.5m &middot; Goods in Transit up to &pound;50k<br>
      Registered in England &amp; Wales &middot; <a href="${escAttr(termsUrl)}" style="color:#8A857E;text-decoration:underline;">Terms</a> &middot; <a href="${escAttr(privacyUrl)}" style="color:#8A857E;text-decoration:underline;">Privacy</a>
    </p>
  </td></tr>`;

  return {
    title: name,
    headerRow,
    ctaColour,
    signOff: `The ${name} Team`,
    footerRow,
  };
}

export interface BrandedEmailInput {
  /** Hidden inbox-preview line. */
  preheader: string;
  /** Optional "Hi {greeting}," row. */
  greeting?: string;
  /** Optional big light headline. */
  headline?: string;
  /** Body paragraphs — one <p> each; single newlines become <br>. */
  paragraphs: string[];
  /** Optional red call button. */
  cta?: { label: string; url: string };
  /** Brand chrome (multi-brand PRD §3.5). Omit, null, or the marley row →
   *  today's exact single-brand bytes. */
  brand?: Brand | null;
}

/** Compose an ad-hoc customer email in the house style. */
export function brandedEmailHtml({
  preheader,
  greeting,
  headline,
  paragraphs,
  cta,
  brand,
}: BrandedEmailInput): string {
  const chrome =
    !brand || brand.slug === DEFAULT_BRAND ? MARLEY_CHROME : brandChrome(brand);
  const rows: string[] = [];

  if (greeting && greeting.trim()) {
    rows.push(`  <tr><td style="padding:28px 36px 0;">
    <p style="margin:0;font-size:14px;font-weight:600;color:${INK_SOFT};">Hi ${esc(greeting.trim())},</p>
  </td></tr>`);
  }

  if (headline && headline.trim()) {
    rows.push(`  <tr><td style="padding:${greeting ? "8px" : "28px"} 36px 6px;">
    <h1 style="font-family:${FONT_STACK};font-size:29px;font-weight:300;color:${INK};letter-spacing:-0.02em;line-height:1.2;margin:0;">${esc(headline.trim())}</h1>
  </td></tr>`);
  }

  const firstBodyPad = headline || greeting ? "12px" : "28px";
  paragraphs
    .filter((p) => p != null && String(p).trim() !== "")
    .forEach((p, i) => {
      const html = esc(String(p).trim()).replace(/\n/g, "<br>");
      rows.push(`  <tr><td style="padding:${i === 0 ? firstBodyPad : "0"} 36px 16px;">
    <p style="font-size:14.5px;color:${INK_SOFT};line-height:1.7;margin:0;">${html}</p>
  </td></tr>`);
    });

  if (cta && cta.label && cta.url) {
    rows.push(`  <tr><td align="center" style="padding:8px 36px 14px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${chrome.ctaColour}" style="border-radius:8px;">
      <a href="${escAttr(cta.url)}" style="display:inline-block;padding:17px 52px;background:${chrome.ctaColour};color:#FFFFFF;font-size:14.5px;font-weight:600;text-decoration:none;border-radius:8px;letter-spacing:0.02em;font-family:${FONT_STACK};">${esc(cta.label)}</a>
    </td></tr></table>
  </td></tr>`);
  }

  // Team sign-off, then the standard footer.
  rows.push(`  <tr><td style="padding:10px 36px 30px;">
    <p style="margin:0;font-size:14px;color:${INK};">${esc(chrome.signOff)}</p>
  </td></tr>`);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(chrome.title)}</title>${FONT_LINK}</head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:${FONT_STACK};color:${INK};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">${esc(preheader)}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
${chrome.headerRow}
${rows.join("\n")}
${chrome.footerRow}
</table>
</td></tr>
</table>
</body>
</html>`;
}
