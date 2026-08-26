import { brandCtaColour, DEFAULT_BRAND, type Brand } from "@/lib/brand";

/**
 * ONE bank account for every brand (PRD §2): the Marley Moves account, which
 * is exactly why disclosure (a) below exists. Canonical here so the theme and
 * the builders can't drift; payment-email.ts re-exports it for its existing
 * importers.
 */
export const BANK_DETAILS = {
  name: "MARLEYMOVES LTD",
  sortCode: "04-00-03",
  account: "12787423",
} as const;

/**
 * Brand theme for the bespoke transactional email builders (multi-brand PRD
 * §3.5) — quote, payment, date-confirm, commitment-chase, cancellation,
 * refund, storage and survey emails all render through the values here.
 *
 * THE HEADLINE PROPERTY: with `brand` absent, null, or the marley row, every
 * field below IS today's literal string — the default theme is written out
 * verbatim, never derived from the brands row — so the marley render stays
 * BYTE-IDENTICAL to the single-brand output (test-locked in
 * tests/lib/comms/email-brand.test.ts). Other brands derive their theme from
 * the row, falling back per-field to the Marley value where a Phase 0 stub
 * row has gaps (PRD §10).
 *
 * The two REQUIRED DISCLOSURES for non-default brands live here too, so every
 * builder states them identically:
 *  - payToNote: payment goes to MarleyMoves Ltd (rendered INSIDE the bank
 *    details block, where the surprise happens), naming the account and the
 *    brand-prefixed reference.
 *  - attendNote: a Marley Moves vehicle or crew may attend (booking
 *    confirmation + pre-move comms).
 * Both are empty strings for the default brand — Marley copy changes by zero.
 *
 * Pure server util — no React, no DOM, no IO. UK English, no em-dash.
 */

const RED = "#C03838";
const MARLEY_LOGO_URL = "https://quotes.marleymoves.co.uk/logo.png";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape text destined for a double-quoted attribute value. */
const escAttr = (s: string): string => escapeHtml(s).replace(/"/g, "&quot;");

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/** Mix `hex` toward white by `weight` (0..1) — email-safe solid tints (rgba
 *  falls over in Outlook desktop, so pills and borders take solid colours). */
function mixWithWhite(hex: string, weight: number): string {
  if (!HEX_COLOUR.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * weight);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

export interface EmailTheme {
  /** True for marley/absent — the literal-Marley render. */
  isDefault: boolean;
  /** Customer-facing brand name, e.g. "Marley Moves". */
  name: string;
  /** Brand phone in display form. */
  phone: string;
  /** tel: href for the phone. */
  telHref: string;
  /** Front-door address customers can write to. */
  helloAddress: string;
  /** Marketing site, scheme included. */
  websiteUrl: string;
  /** Marketing site label without the scheme. */
  websiteLabel: string;
  /** The interactive accent — buttons, borders, highlight text. */
  accent: string;
  /** Accent readable on the #1A1A1A dark footers. */
  accentOnDark: string;
  /** Ref-pill background / border tints. */
  pillBg: string;
  pillBorder: string;
  /** The header logo/wordmark markup (width 180, the bespoke-shell size). */
  logoHtml: string;
  /** Light-footer identity, e.g. `Marley <span …>Moves</span>`. */
  footerIdentityHtml: string;
  /** Light-footer meta line under the identity (legal line for other brands). */
  footerMetaHtml: string;
  /** "Part of the Marley Group" — empty for the default brand. */
  groupLine: string;
  /** "call Connor on <strong>01747 637070</strong>" (marley) / "call us on …". */
  callHtml: string;
  /** Capitalised variant for sentence starts. */
  callHtmlCap: string;
  /** Plain-text variants for text bodies. */
  callText: string;
  callTextCap: string;
  /** The "call us" wording (some Marley copy says "us", not "Connor"). */
  callUsHtml: string;
  callUsHtmlCap: string;
  callUsText: string;
  callUsTextCap: string;
  /** Whether card-payment wording may appear in this brand's copy. Always
   *  true for the default theme (Marley's literals already name card; they
   *  are never edited here), opts.cardPhone for other brands. */
  cardPhone: boolean;
  /** "How to pay" methods sentence in the bank-details card. */
  payMethodsLine: string;
  /** Plain-text pay-methods sentence for text bodies. */
  payMethodsText: string;
  /** Disclosure (a): payment goes to MarleyMoves Ltd — "" for marley. Call
   *  with the payment reference the customer must quote. */
  payToNoteHtml(reference: string): string;
  payToNoteText(reference: string): string;
  /** Disclosure (b): a Marley Moves vehicle or crew may attend — "" for marley. */
  attendNoteHtml: string;
  attendNoteText: string;
}

// Today's exact literals — the marley/absent theme is these strings, verbatim,
// so byte-identity never depends on the brands row round-tripping.
const MARLEY_THEME: EmailTheme = {
  isDefault: true,
  name: "Marley Moves",
  phone: "01747 637070",
  telHref: "tel:01747637070",
  helloAddress: "hello@marleymoves.co.uk",
  websiteUrl: "https://marleymoves.co.uk",
  websiteLabel: "marleymoves.co.uk",
  accent: RED,
  accentOnDark: "#E85959",
  pillBg: "#FFF3F1",
  pillBorder: "#F5C9C4",
  logoHtml: `<img src="${MARLEY_LOGO_URL}" alt="Marley Moves" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">`,
  footerIdentityHtml: `Marley <span style="color:#C03838;">Moves</span>`,
  footerMetaHtml: `Shaftesbury, SP7 · Company No. 15914266`,
  groupLine: "",
  callHtml: `call Connor on <strong style="color:#C03838;">01747 637070</strong>`,
  callHtmlCap: `Call Connor on <strong style="color:#C03838;">01747 637070</strong>`,
  callText: `call Connor on 01747 637070`,
  callTextCap: `Call Connor on 01747 637070`,
  callUsHtml: `call us on <strong style="color:#C03838;">01747 637070</strong>`,
  callUsHtmlCap: `Call us on <strong style="color:#C03838;">01747 637070</strong>`,
  callUsText: `call us on 01747 637070`,
  callUsTextCap: `Call us on 01747 637070`,
  cardPhone: true,
  payMethodsLine: `Bank transfer, card over the phone on 01747 637070, or cash. Whichever suits.`,
  payMethodsText: `You can pay by bank transfer, by card over the phone on 01747 637070, or in cash if that is easier:`,
  payToNoteHtml: () => "",
  payToNoteText: () => "",
  attendNoteHtml: "",
  attendNoteText: "",
};

export interface EmailThemeOptions {
  /** Whether the brand's phone-card channel is live (global AND per-brand
   *  switches, PRD §11.10) — drives the word "card" in non-default pay copy.
   *  Ignored for the default brand (its literals stand as today). Defaults
   *  false: bank transfer + cash only, the Pitmans launch posture. */
  cardPhone?: boolean;
}

/**
 * The email theme for a brand. Marley/absent/null → the literal Marley theme;
 * any other row derives its theme with per-field Marley fallbacks for stub
 * gaps. The group pseudo-brand is never passed here — group comms keep
 * Marley's identity end to end (PRD §11.10) — but if it ever were, its null
 * email fields would degrade to the Marley values rather than render blanks.
 */
export function emailTheme(brand?: Brand | null, opts?: EmailThemeOptions): EmailTheme {
  if (!brand || brand.slug === DEFAULT_BRAND) return MARLEY_THEME;

  const name = brand.name.trim() || "Marley Moves";
  const nameEsc = escapeHtml(name);
  const phone = (brand.phone ?? "").trim() || "01747 637070";
  const phoneEsc = escapeHtml(phone);
  const telHref = "tel:" + phone.replace(/[^0-9+]/g, "");
  const helloAddress = (brand.helloFrom ?? "").trim() || "hello@marleymoves.co.uk";
  const websiteUrl = ((brand.websiteUrl ?? "").trim() || "https://marleymoves.co.uk").replace(/\/+$/, "");
  const websiteLabel = websiteUrl.replace(/^https?:\/\//, "");
  const accent = brandCtaColour(brand) ?? RED;

  // Header wordmark colour when the row has no logo yet: the primary when
  // it's a real hex, ink otherwise (same data rule as branded-shell.ts).
  const primary = (brand.colourPrimary ?? "").trim();
  const wordmarkColour = HEX_COLOUR.test(primary) ? primary : "#1A1A1A";
  const logoHtml = brand.logoUrl
    ? `<img src="${escAttr(brand.logoUrl)}" alt="${escAttr(name)}" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">`
    : `<span style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:${wordmarkColour};letter-spacing:-0.02em;">${nameEsc}</span>`;

  const legalLine = brand.legalLine.trim() || "MarleyMoves Ltd · Company No. 15914266 · VAT 520 2213 58";
  const groupLine = brand.groupLine.trim();

  const callHtml = `call us on <strong style="color:${accent};">${phoneEsc}</strong>`;
  const callHtmlCap = `Call us on <strong style="color:${accent};">${phoneEsc}</strong>`;
  const cardPhone = opts?.cardPhone === true;
  const payMethodsLine = cardPhone
    ? `Bank transfer, card over the phone on ${phoneEsc}, or cash. Whichever suits.`
    : `Bank transfer or cash. Whichever suits.`;
  const payMethodsText = cardPhone
    ? `You can pay by bank transfer, by card over the phone on ${phone}, or in cash if that is easier:`
    : `You can pay by bank transfer, or in cash if that is easier:`;

  // Disclosure (a) — PRD §3.5: payment goes to MarleyMoves Ltd, the account is
  // named, and the brand-prefixed reference is given, INSIDE the bank block.
  const payToNoteText = (reference: string) =>
    `${name} is part of MarleyMoves Ltd, so your payment goes to the ${BANK_DETAILS.name} account above. Please use reference ${reference} so we can match it to your booking.`;
  const payToNoteHtml = (reference: string) =>
    `${nameEsc} is part of MarleyMoves Ltd, so your payment goes to the <strong style="color:#1A1A1A;">${BANK_DETAILS.name}</strong> account above. Please use reference <strong style="color:#1A1A1A;">${escapeHtml(reference)}</strong> so we can match it to your booking.`;

  // Disclosure (b) — PRD §3.5: a Marley Moves vehicle or crew may attend.
  const attendNoteText = `${name} is part of the Marley Group, so a Marley Moves vehicle or crew may attend on the day. Same team standards, whichever livery arrives.`;
  const attendNoteHtml = `${nameEsc} is part of the Marley Group, so a Marley Moves vehicle or crew may attend on the day. Same team standards, whichever livery arrives.`;

  return {
    isDefault: false,
    name,
    phone,
    telHref,
    helloAddress,
    websiteUrl,
    websiteLabel,
    accent,
    accentOnDark: mixWithWhite(accent, 0.55),
    pillBg: mixWithWhite(accent, 0.92),
    pillBorder: mixWithWhite(accent, 0.72),
    logoHtml,
    footerIdentityHtml: nameEsc,
    footerMetaHtml: escapeHtml(legalLine),
    groupLine,
    callHtml,
    callHtmlCap,
    callText: `call us on ${phone}`,
    callTextCap: `Call us on ${phone}`,
    callUsHtml: callHtml,
    callUsHtmlCap: callHtmlCap,
    callUsText: `call us on ${phone}`,
    callUsTextCap: `Call us on ${phone}`,
    cardPhone,
    payMethodsLine,
    payMethodsText,
    payToNoteHtml,
    payToNoteText,
    attendNoteHtml,
    attendNoteText,
  };
}

/* --------------------------------------------------------- shared fragments
   The bespoke builders (payment, date-confirm, commitment-chase, refund,
   cancellation) previously each carried a verbatim copy of these; one
   brand-aware implementation keeps every send's chrome in step. The default
   theme reproduces the old output byte for byte. */

/** The light shell every money email shares: logo header, inner rows, footer. */
export function themedEmailShell(preheader: string, inner: string, t: EmailTheme = MARLEY_THEME): string {
  const groupRow = t.groupLine
    ? `\n        <div style="margin-top:2px;">${escapeHtml(t.groupLine)}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(t.name)}</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">${preheader}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 8px;">
    ${t.logoHtml}
  </td></tr>
${inner}
  <tr><td style="background:#FAFAFA;border-top:1px solid #EAE7E2;padding:20px 36px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:11px;color:#6E6A65;line-height:1.7;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:600;color:#1A1A1A;">${t.footerIdentityHtml}</div>${groupRow}
        <div style="margin-top:2px;">${t.footerMetaHtml}</div>
      </td>
      <td align="right" style="font-size:11px;color:#6E6A65;line-height:1.7;">
        <div><a href="${t.telHref}" style="color:#1A1A1A;text-decoration:none;font-weight:600;">${escapeHtml(t.phone)}</a></div>
        <div><a href="${t.websiteUrl}" style="color:#6E6A65;text-decoration:none;">${escapeHtml(t.websiteLabel)}</a></div>
      </td>
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The uppercase reference pill under the logo. */
export function themedPill(label: string, t: EmailTheme = MARLEY_THEME): string {
  return `  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:${t.pillBg};border:1px solid ${t.pillBorder};border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${t.accent};">${label}</div>
  </td></tr>`;
}

/** The accent CTA button row ("View your invoice →" and friends). */
export function themedButtonRow(href: string, labelHtml: string, t: EmailTheme = MARLEY_THEME): string {
  return `  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${t.accent}" style="border-radius:6px;">
      <a href="${href}" style="display:inline-block;padding:15px 38px;background:${t.accent};color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">${labelHtml}</a>
    </td></tr></table>
  </td></tr>`;
}

/**
 * The "How to pay" bank-details card. For a non-default brand the pay-methods
 * line comes from the theme (card copy only when the brand's card channel is
 * live) and disclosure (a) renders inside the card — the block where a
 * customer would otherwise be surprised by the MarleyMoves Ltd account name.
 */
export function themedBankCard(reference: string, t: EmailTheme = MARLEY_THEME): string {
  const row = (l: string, v: string) => `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:42%;">${l}</td>
    <td style="padding:8px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;">${v}</td>
  </tr>`;
  const payToNote = t.payToNoteHtml(reference);
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:10px;">How to pay</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row("Account name", BANK_DETAILS.name)}
          ${row("Sort code", BANK_DETAILS.sortCode)}
          ${row("Account number", BANK_DETAILS.account)}
          <tr>
            <td style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Reference</td>
            <td style="padding:8px 0;font-size:14px;color:${t.accent};font-weight:700;">${escapeHtml(reference)}</td>
          </tr>
        </table>
        <p style="margin:10px 0 0;font-size:12.5px;line-height:1.6;color:#6E6A65;">${t.payMethodsLine}</p>${
          payToNote
            ? `\n        <p style="margin:10px 0 0;font-size:12.5px;line-height:1.6;color:#6E6A65;">${payToNote}</p>`
            : ""
        }
      </td></tr>
    </table>
  </td></tr>`;
}

/** The dark (#1A1A1A) footer used by the completion, survey and storage
 *  emails — brand identity, group disclosure and contact links. */
export function themedDarkFooter(t: EmailTheme = MARLEY_THEME): string {
  const groupPart = t.groupLine ? `${escapeHtml(t.groupLine)}<br>\n    ` : "";
  return `  <tr><td style="padding:20px 36px;background:#1A1A1A;">
    <p style="margin:0;font-size:12px;color:#B8B3AC;line-height:1.7;">${escapeHtml(t.name)} · Company No. 15914266 · ${escapeHtml(t.phone)}<br>
    ${groupPart}<a href="mailto:${escAttr(t.helloAddress)}" style="color:${t.accentOnDark};text-decoration:none;">${escapeHtml(t.helloAddress)}</a> · <a href="${t.websiteUrl}" style="color:${t.accentOnDark};text-decoration:none;">${escapeHtml(t.websiteLabel)}</a></p>
  </td></tr>`;
}
