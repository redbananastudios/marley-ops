/**
 * Create/update + publish the panel's Resend email templates so their design is
 * manageable in the Resend dashboard (no deploy needed for copy/layout tweaks).
 *
 * House style signed off with Peter 2026-07-13 (see docs/email-audit.md): white
 * logo header, Montserrat, big light headline, red numbered steps, tick panel,
 * red call button, and the STANDARD_FOOTER (MarleyMoves Ltd + VAT + full address
 * + insurance + Registered in England & Wales) on every email.
 *
 * Usage:
 *   RESEND_FULL_API_KEY=re_... node scripts/create-resend-templates.mjs
 *   node scripts/create-resend-templates.mjs --preview-dir <directory>
 *   node scripts/create-resend-templates.mjs --only chase-deposit-2
 *
 * Idempotent: matches templates by name; existing ones are updated (PATCH) and
 * republished, so the template ids never change (no env re-wiring needed).
 *
 * The everyday MARLEY_RESEND_API_KEY works here (verified 2026-07-13 — it has
 * full template read/write). Without a key you can still --preview-dir.
 *
 * --brand <slug> (default marley) builds the set for another brand with
 * BRAND-PREFIXED template names ("pitmans-quote-email"), so a Pitmans run can
 * never name-collide with the live Marley set (multi-brand PRD §11.7 trap 4).
 * Brand copy, colours and addresses come from BRAND_CONFIGS below — an
 * offline mirror of the seeded brands rows (supabase/migrations/0104_brands.sql).
 * THE DB ROW IS CANONICAL; the inline lookup exists only because this script
 * runs outside the app with no database access. Group comms (the crew portal
 * invite) stay Marley-only per PRD §11.10 and are never cloned per brand.
 *
 *   node scripts/create-resend-templates.mjs --brand pitmans --preview-dir .resend-preview/pitmans
 *
 * LIVE PUSH FOR PITMANS IS GATED: do not run a keyed --brand pitmans push
 * until Resend domain verification for pitmansremovals.co.uk lands (Phase 0).
 * After a live push the script prints the envVar -> id JSON. Store it on the
 * brand row (id capture, PRD §3.5) with:
 *
 *   update brands
 *      set resend_template_ids = '<paste the printed JSON>'::jsonb
 *    where slug = 'pitmans';
 *
 * The JSON is keyed by the ENV VAR NAME ("RESEND_TEMPLATE_QUOTE_EMAIL"),
 * because that is the key templateIdFor(brand, envName) resolves and the
 * identifier every call site already passes — see lib/comms/template-id.ts.
 * The hosted NAME is a separate identifier (it is the PATCH match key, and it
 * carries the brand prefix), and it is not mechanically convertible into the
 * env var, so recording ids under it would produce a map no send ever hits.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const previewArg = process.argv.indexOf("--preview-dir");
const PREVIEW_DIR = previewArg >= 0 ? process.argv[previewArg + 1] : null;

// --only <name>[,<name>...] limits the run to the named templates, so a
// single-copy tweak doesn't re-push (and potentially clobber) the other 19.
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? "").split(",").filter(Boolean)) : null;

// --brand <slug> selects whose set to build. Default marley: a no-flag run is
// byte-identical to the script's original single-brand behaviour (unprefixed
// names, env-var lines printed). Non-marley sets take brand-prefixed names so
// a push can never PATCH a live Marley template by name (PRD §11.7 trap 4).
const brandArg = process.argv.indexOf("--brand");
const BRAND = brandArg >= 0 ? (process.argv[brandArg + 1] ?? "") : "marley";

/* ================================================================= brands
 * Offline mirror of the seeded brands rows (supabase/migrations/0104_brands.sql)
 * plus the per-brand template copy that exists only here. THE DB ROW IS
 * CANONICAL for every value it also carries (colours, phones, addresses,
 * from-addresses): if the row changes, change this mirror in the same commit.
 */
const BRAND_CONFIGS = {
  marley: {
    // Every value here is today's live literal. The no-flag run must remain
    // byte-identical to the pre-refactor script (verified render-to-render at
    // gate 13) — do not "tidy" these strings.
    namePrefix: "",
    name: "Marley Moves",
    signoff: "The Marley Moves Team",
    logoUrl: "https://marleymoves.co.uk/logo.png",
    accent: "#C03838",
    headerTdAttrs: 'style="padding:34px 36px 22px;border-bottom:1px solid #EFECE7;"',
    phone: "01747 637070",
    phoneHref: "01747637070",
    email: "hello@marleymoves.co.uk",
    websiteUrl: "https://marleymoves.co.uk",
    websiteLabel: "marleymoves.co.uk",
    footerLegalHtml:
      '<strong style="color:#5A554F;">MarleyMoves Ltd</strong> &middot; Company No. 15914266 &middot; VAT 520 2213 58',
    footerAddress: "Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX",
    termsUrl: "https://marleymoves.co.uk/terms-conditions",
    privacyUrl: "https://marleymoves.co.uk/privacy-policy",
    helloFrom: "Marley Moves <hello@marleymoves.co.uk>",
    moneyFrom: "Marley Moves <accounts@marleymoves.co.uk>",
    howToPayLine: "Bank transfer, card over the phone on 01747 637070, or cash. Whichever suits.",
    payEntityNoteHtml: "",
    fleetNoteLine: "",
    quoteDepositStepDesc: "Card or bank transfer. This secures your booking; confirming your date then locks it in.",
    chaseDeposit1PayLine: "You can pay by card or bank transfer on your quote page (bank transfer reference: {{{QUOTE_REF}}}):",
    depositChaseEntityLine: "",
    reviewCrewPhrase: "Connor and the crew",
    reviewUrlFallback: "https://g.page/r/CXD_Yh4RUF1cEBM/review",
    quoteLinkFallback: "https://marleymoves.co.uk/quote/",
    refundSlaFallback:
      "Card refunds normally show on your statement within 3 to 5 working days and bank transfers usually arrive the same day, all well within the 14 days we promise.",
    includeCrewInvite: true,
    previewOverrides: {},
  },
  pitmans: {
    // PRD §3.5: yellow header band; buttons, links and accents blue. Card
    // copy is ABSENT throughout — brands.card_payments_enabled is false for
    // Pitmans and the word "card" may only reach customer copy when the
    // global AND brand switches are both true (§11.10). Both §3.5 disclosures
    // live here: payment emails name MarleyMoves Ltd with the PM reference;
    // booking-confirmation and pre-move emails note a Marley Moves vehicle or
    // crew may attend.
    namePrefix: "pitmans-",
    name: "Pitmans Removals & Storage",
    signoff: "The Pitmans Removals Team",
    // PLACEHOLDER (Phase 0): real logo asset pending from Mark — §10 stubs.
    logoUrl: "https://pitmansremovals.co.uk/logo.png",
    accent: "#2B2B76",
    headerTdAttrs: 'bgcolor="#FFCC00" style="padding:34px 36px 22px;background:#FFCC00;"',
    phone: "01258 858564",
    phoneHref: "01258858564",
    email: "info@pitmansremovals.co.uk",
    websiteUrl: "https://pitmansremovals.co.uk",
    websiteLabel: "pitmansremovals.co.uk",
    footerLegalHtml:
      '<strong style="color:#5A554F;">Pitmans Removals &amp; Storage</strong> is a trading name of MarleyMoves Ltd &middot; Company No. 15914266 &middot; VAT 520 2213 58',
    footerAddress: "Uplands Business Park, Blandford Heights, Shaftesbury Road, Blandford Forum, Dorset DT11 7UZ",
    // Marley's documents on purpose until gate 15 ships the unified terms
    // (0104 seed: terms_url null renders Marley terms). MarleyMoves Ltd is
    // the legal entity and data controller for both brands.
    termsUrl: "https://marleymoves.co.uk/terms-conditions",
    privacyUrl: "https://marleymoves.co.uk/privacy-policy",
    helloFrom: "Pitmans Removals & Storage <info@pitmansremovals.co.uk>",
    // accounts@ is provisional (Phase 0 mailbox list pending Mark) — §10 stubs.
    moneyFrom: "Pitmans Removals & Storage <accounts@pitmansremovals.co.uk>",
    howToPayLine: "Bank transfer or cash. Whichever suits.",
    payEntityNoteHtml:
      '\n        <div style="font-size:12.5px;color:#5A554F;line-height:1.55;margin-bottom:12px;">Pitmans Removals &amp; Storage is part of the Marley Group. Your payment goes to our parent company, MarleyMoves Ltd, using the account details and reference below.</div>',
    fleetNoteLine:
      "One thing worth knowing: a Marley Moves vehicle or crew, part of the same family firm, may carry out your move.",
    quoteDepositStepDesc:
      "By bank transfer, details on your quote page. This secures your booking; confirming your date then locks it in.",
    chaseDeposit1PayLine:
      "You can pay by bank transfer from your quote page. Your payment goes to our parent company, MarleyMoves Ltd, with reference {{{QUOTE_REF}}}:",
    depositChaseEntityLine:
      "A quick note on payment: your deposit goes to our parent company, MarleyMoves Ltd, with reference {{{QUOTE_REF}}}.",
    reviewCrewPhrase: "the crew",
    // PLACEHOLDER (Phase 0): the Pitmans Google listing link is pending. The
    // app only sends review requests when brands.review_url is set, and it
    // must never fall back to Marley's listing (0104 seed comment).
    reviewUrlFallback: "https://pitmansremovals.co.uk",
    quoteLinkFallback: "https://pitmansremovals.co.uk",
    refundSlaFallback: "Bank transfers usually arrive the same day, well within the 14 days we promise.",
    includeCrewInvite: false, // group comm — Marley-only per PRD §11.10
    previewOverrides: {
      OWNER_NAME: "Mark",
      QUOTE_REF: "PMR017",
      REPLY_HREF: "mailto:info@pitmansremovals.co.uk",
    },
  },
};

const B = BRAND_CONFIGS[BRAND];
if (!B) {
  console.error(`Unknown --brand "${BRAND}". Known brands: ${Object.keys(BRAND_CONFIGS).join(", ")}`);
  process.exit(1);
}

const KEY = process.env.RESEND_FULL_API_KEY || process.env.MARLEY_RESEND_FULL_API_KEY || process.env.MARLEY_RESEND_API_KEY;
if (!KEY && !PREVIEW_DIR) {
  console.error("Set RESEND_FULL_API_KEY (or MARLEY_RESEND_API_KEY) for the Marley Resend team.");
  process.exit(1);
}

const API = "https://api.resend.com";
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

/** Build the full template registry for one brand. Everything brand-specific
 *  reads from `B`; the marley config reproduces the original output byte for
 *  byte (verified against a pre-refactor render) — keep it that way. */
function buildTemplateSet(B) {
/* ================================================================ house style */

const LOGO_URL = B.logoUrl;
const FONT_STACK = "'Montserrat','Segoe UI',Helvetica,Arial,sans-serif";
const FONT_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">';
const ACCENT = B.accent;
const INK = "#1A1A1A";
const INK_SOFT = "#5A554F";
const PHONE = B.phone;

// Standard footer on EVERY email. Legal name MarleyMoves Ltd (one word); brand
// "Marley Moves" (space) stays in body copy + team sign-off.
const STANDARD_FOOTER = `  <tr><td style="padding:26px 36px;border-top:1px solid #EAE7E2;">
    <p style="margin:0;font-size:11px;line-height:1.85;color:#8A857E;text-align:center;">
      ${B.footerLegalHtml}<br>
      ${B.footerAddress}<br>
      <a href="tel:${B.phoneHref}" style="color:#8A857E;text-decoration:none;">${B.phone}</a> &middot; <a href="mailto:${B.email}" style="color:#8A857E;text-decoration:none;">${B.email}</a> &middot; <a href="${B.websiteUrl}" style="color:#8A857E;text-decoration:none;">${B.websiteLabel}</a><br>
      Fully insured: Public Liability up to &pound;2.5m &middot; Goods in Transit up to &pound;50k<br>
      Registered in England &amp; Wales &middot; <a href="${B.termsUrl}" style="color:#8A857E;text-decoration:underline;">Terms</a> &middot; <a href="${B.privacyUrl}" style="color:#8A857E;text-decoration:underline;">Privacy</a>
    </p>
  </td></tr>`;

const shellHtml = (preheader, inner) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${B.name}</title>${FONT_LINK}</head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:${FONT_STACK};color:${INK};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">${preheader}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" ${B.headerTdAttrs}>
    <img src="${LOGO_URL}" alt="${B.name}" width="200" style="display:block;margin:0 auto;height:auto;max-width:64%;border:0;outline:none;text-decoration:none;">
  </td></tr>
${inner}
${STANDARD_FOOTER}
</table>
</td></tr>
</table>
</body>
</html>`;

/* ---- slot helpers (V3 "Airy Premium": greeting, big light headline, left aligned) */

const greetRow = (name) => `  <tr><td style="padding:28px 36px 0;">
    <p style="margin:0;font-size:14px;font-weight:600;color:${INK_SOFT};">Hi ${name},</p>
  </td></tr>`;
const headlineRow = (text) => `  <tr><td style="padding:8px 36px 6px;">
    <h1 style="font-family:${FONT_STACK};font-size:29px;font-weight:300;color:${INK};letter-spacing:-0.02em;line-height:1.2;margin:0;">${text}</h1>
  </td></tr>`;
const sublineRow = (html, pad = "12px 36px 22px") => `  <tr><td style="padding:${pad};">
    <p style="font-size:14.5px;color:${INK_SOFT};line-height:1.7;margin:0;">${html}</p>
  </td></tr>`;
const signoffRow = () => `  <tr><td style="padding:8px 36px 30px;">
    <p style="margin:0;font-size:14px;color:${INK};">${B.signoff}</p>
  </td></tr>`;

// §3.5 disclosure: Pitmans booking-confirmation and pre-move emails note a
// Marley Moves vehicle or crew may attend. Empty for Marley (renders nothing).
const fleetNoteRows = B.fleetNoteLine ? [sublineRow(B.fleetNoteLine, "0 36px 16px")] : [];

const fact = (label, value, last = false) => `
      <tr>
        <td style="padding:10px 0;${last ? "" : "border-bottom:1px solid #F0EDE8;"}font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:38%;">${label}</td>
        <td style="padding:10px 0;${last ? "" : "border-bottom:1px solid #F0EDE8;"}font-size:14px;color:${INK};font-weight:600;">${value}</td>
      </tr>`;
const factsCard = (rows) => `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7E4DE;border-radius:8px;overflow:hidden;"><tr><td style="padding:16px 24px;border-left:4px solid ${ACCENT};">
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    </td></tr></table>
  </td></tr>`;

const stepsRow = (steps) => `  <tr><td style="padding:4px 36px 22px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${ACCENT};margin-bottom:16px;">What happens next</div>
    <table width="100%" cellpadding="0" cellspacing="0">${steps
      .map(
        (s, i) => `<tr>
      <td valign="top" width="40" style="padding:0 12px 16px 0;"><table cellpadding="0" cellspacing="0"><tr><td width="28" height="28" align="center" valign="middle" bgcolor="${ACCENT}" style="width:28px;height:28px;border-radius:50%;font-size:13px;font-weight:700;color:#FFFFFF;font-family:${FONT_STACK};">${i + 1}</td></tr></table></td>
      <td valign="top" style="padding:0 0 16px;font-size:14px;color:${INK_SOFT};line-height:1.5;"><strong style="color:${INK};font-weight:600;">${s.t}</strong><br>${s.d}</td>
    </tr>`,
      )
      .join("")}</table>
  </td></tr>`;

const linkButton = (label, href) => `  <tr><td align="center" style="padding:2px 36px 10px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${ACCENT}" style="border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:16px 36px;background:${ACCENT};color:#FFFFFF;font-size:14.5px;font-weight:600;text-decoration:none;border-radius:8px;letter-spacing:0.02em;white-space:nowrap;font-family:${FONT_STACK};">${label}</a>
    </td></tr></table>
  </td></tr>`;

const amountCard = (label, amount, note) => `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7E4DE;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${ACCENT};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#8A857E;margin-bottom:6px;">${label}</div>
        <div style="font-family:${FONT_STACK};font-size:34px;font-weight:300;color:${INK};letter-spacing:-0.02em;line-height:1;">${amount}</div>${
          note ? `\n        <div style="font-size:11px;color:#8A857E;margin-top:8px;">${note}</div>` : ""
        }
      </td></tr>
    </table>
  </td></tr>`;

/* paymentCard() lived here: the same block but headed "Card via the button
 * above; bank details below". Only the balance-invoice template ever called it,
 * and that email's button is "View your invoice" pointing at an invoice raised
 * with online payments disabled — so the sentence sent customers to a page that
 * could not take their money (Greig James MMR015, 2026-08-20). Deleted rather
 * than left dangling: no email in this file offers an online card button, so a
 * helper that claims one is a bug waiting for its next caller. If a card-payable
 * email is ever added, write its copy against that specific button. */

/** Payment card without an online card button: the commitment and balance
 *  rails are BACS/cash/card-by-phone (card accepted, Peter 2026-07-29 — only
 *  the online button stays deposit-only). */
const bankOnlyCard = (reference) => {
  const row = (l, v) => `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:42%;">${l}</td>
    <td style="padding:8px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:${INK};font-weight:600;">${v}</td>
  </tr>`;
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F4;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#8A857E;margin-bottom:4px;">How to pay</div>
        <div style="font-size:12.5px;color:${INK_SOFT};line-height:1.55;margin-bottom:12px;">${B.howToPayLine}</div>${B.payEntityNoteHtml}
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row("Account name", "MARLEYMOVES LTD")}
          ${row("Sort code", "04-00-03")}
          ${row("Account number", "12787423")}
          <tr>
            <td style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Reference</td>
            <td style="padding:8px 0;font-size:14px;color:${ACCENT};font-weight:700;">${reference}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;
};

/** Itemised refund card: LINES_VAR is pre-rendered <tr> rows (one per rail)
 *  from lib/comms/refund-emails.ts lineRows(); the total row closes it. */
const refundLinesCard = (title, linesVar, totalLabel, totalVar) => `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F4;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#8A857E;margin-bottom:10px;">${title}</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${linesVar}
          <tr>
            <td style="padding:10px 0 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">${totalLabel}</td>
            <td align="right" style="padding:10px 0 0;font-size:16px;color:${ACCENT};font-weight:700;white-space:nowrap;">${totalVar}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;

/* ---- Payments Policy v2 money mail (docs/payments-policy-v2-prd.md §5E).
   Sent from the accounts desk; the app passes From per send (accountsFrom()),
   this is the template default. Variable composers live beside the fallback
   builders in lib/comms/{date-confirm,commitment-chase,cancellation,refund}-
   emails.ts — the template mirrors the fallback so the two paths never drift.
   Copy rule (test-enforced): the word "penalty" appears NOWHERE; held money is
   always "held against your original date, refunded in full if we re-book it". */
const MONEY_FROM = B.moneyFrom;

const dateConfirmationHtml = shellHtml(
  "Your move date is confirmed. Here's what happens next with your booking.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Your date is locked in."),
    sublineRow(
      `Thank you for confirming your move on <strong style="color:${INK};">{{{MOVE_DATE_LABEL}}}</strong> (ref {{{QUOTE_REF}}}). Your <strong style="color:${INK};">{{{DEPOSIT_AMOUNT}}}</strong> deposit is now held against your booking: from this point it is non-refundable and still counts towards your final bill.`,
    ),
    "{{{COMMITMENT_BLOCK}}}",
    sublineRow("{{{HELD_POSITION_LINE}}}", "0 36px 16px"),
    ...fleetNoteRows,
    sublineRow(
      `Any questions, call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const commitmentReceivedHtml = shellHtml(
  "We've received your {{{AMOUNT}}} commitment payment. It counts towards your final bill.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Commitment received. Thank you."),
    sublineRow(
      `We've received your <strong style="color:${INK};">{{{AMOUNT}}}</strong> commitment payment for your move on <strong style="color:${INK};">{{{MOVE_DATE_LABEL}}}</strong> (ref {{{QUOTE_REF}}}). It counts towards your final bill.`,
    ),
    amountCard("Commitment paid", "{{{AMOUNT}}}"),
    sublineRow(
      "Your remaining balance is due in full before move day, and we'll send the final invoice nearer the time.",
      "0 36px 16px",
    ),
    sublineRow(
      `Any questions, call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const commitmentChaseHtml = shellHtml(
  "Your commitment payment of {{{AMOUNT}}} is due {{{DUE_LABEL}}}.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Your commitment payment."),
    sublineRow(
      `Thank you for confirming your move date of <strong style="color:${INK};">{{{MOVE_DATE_LABEL}}}</strong>. The next step in your booking is your commitment payment, due <strong style="color:${INK};">{{{DUE_LABEL}}}</strong>. Your remaining balance is then due in full before move day.`,
    ),
    amountCard("Commitment due{{{INVOICE_META}}}", "{{{AMOUNT}}}"),
    "{{{INVOICE_BUTTON}}}",
    bankOnlyCard("{{{QUOTE_REF}}}"),
    sublineRow(
      `A quick reminder of what you agreed when you confirmed your date: &ldquo;{{{DATE_CONFIRM_ACK}}}&rdquo;`,
      "0 36px 16px",
    ),
    sublineRow(
      `If anything about your move has changed, or you would like to talk it through, reply to this email or call us on <strong style="color:${ACCENT};">${PHONE}</strong> and we will help.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const cancellationAckHtml = shellHtml(
  "Your move date has changed. Everything you've paid still counts towards your move.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Your move date has changed."),
    sublineRow(
      `We've released your original date of <strong style="color:${INK};">{{{OLD_DATE_LABEL}}}</strong> and booked you in for <strong style="color:${INK};">{{{NEW_DATE_LABEL}}}</strong> (ref {{{QUOTE_REF}}}). No new deposit is needed. Everything you've already paid still counts towards your move.`,
    ),
    "{{{HELD_CARD}}}",
    sublineRow("{{{HELD_SENTENCES}}}", "0 36px 16px"),
    // The booking rolls to a new date, so this is pre-move comms and carries
    // the §3.5 disclosure — same as the date-change confirmation, which is the
    // same rebook sent from outside the 7-day window. Only one of the two ever
    // fires, so a disclosure on one of them is a disclosure on neither.
    ...fleetNoteRows,
    sublineRow(
      `Any questions, call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const refundExecutedHtml = shellHtml(
  `Your {{{TOTAL_REFUND}}} refund from ${B.name} is on its way.`,
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Your refund is on its way."),
    sublineRow(
      `We have now returned everything due back to you for booking {{{QUOTE_REF}}}. Each payment goes back the way it came in.`,
    ),
    refundLinesCard("Refunded to you", "{{{REFUND_LINES}}}", "Total refunded", "{{{TOTAL_REFUND}}}"),
    sublineRow("{{{SLA_LINE}}}", "0 36px 16px"),
    sublineRow(
      `Any questions at all, just reply to this email or call us on <strong style="color:${ACCENT};">${PHONE}</strong>.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const retainedOutcomeHtml = shellHtml(
  "An update on your booking {{{QUOTE_REF}}} and your original move date.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("About your original move date."),
    sublineRow(
      `Despite our best efforts, we were not able to re-book your original move date{{{ORIGINAL_DATE_CLAUSE}}}. As set out in your booking terms, <strong style="color:${INK};">{{{RETAINED_AMOUNT}}}</strong> of what you had paid has been held against that date (ref {{{QUOTE_REF}}}). Had the day re-booked, it would have been refunded in full.`,
    ),
    "{{{REFUND_SECTION}}}",
    sublineRow(
      `If anything here does not look right, or you would like to talk it through, just reply to this email or call us on <strong style="color:${ACCENT};">${PHONE}</strong>.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const marleyCancelHtml = shellHtml(
  "We're sorry: we've had to cancel your move. Everything you've paid is refunded in full.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("We're sorry."),
    sublineRow(
      `We can't do your move{{{MOVE_DATE_CLAUSE}}} and have had to cancel your booking (ref {{{QUOTE_REF}}}). This one is on us, and we're sorry for the disruption.`,
    ),
    "{{{REFUND_CARD}}}",
    sublineRow("{{{REFUND_SENTENCE}}}", "0 36px 16px"),
    sublineRow(
      `If we can help with your move on another date, call <strong style="color:${ACCENT};">the team</strong> on ${PHONE}. We'd like to make it right.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const dateChangeConfirmationHtml = shellHtml(
  "Your new move date is confirmed. Your booking and everything you've paid roll straight over.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("You're booked for {{{NEW_DATE_LABEL}}}."),
    sublineRow(
      `Your move has moved from <strong style="color:${INK};">{{{OLD_DATE_LABEL}}}</strong> to <strong style="color:${INK};">{{{NEW_DATE_LABEL}}}</strong> (ref {{{QUOTE_REF}}}). Your booking carries straight over: same team, same price, nothing to re-do.`,
    ),
    "{{{HELD_CARD}}}",
    sublineRow("{{{HELD_SENTENCE}}}", "0 36px 16px"),
    sublineRow("{{{COMMITMENT_SENTENCE}}}", "0 36px 16px"),
    ...fleetNoteRows,
    sublineRow(
      `Any questions, call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

/* ================================================================= templates */

const surveyConfirmationHtml = shellHtml(
  `Your free home survey with ${B.name} is booked for {{{DATE_LABEL}}} at {{{TIME_LABEL}}}.`,
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("You're booked in."),
    sublineRow(
      `Thank you, your <strong style="color:${INK};">free</strong> home survey is in the diary. {{{ESTIMATOR}}} will come and take a proper look at your move so we can give you an accurate, written fixed price. It won't take long, usually well under an hour.`,
    ),
    factsCard(
      `${fact("When", "{{{DATE_LABEL}}} at {{{TIME_LABEL}}}")}${fact("Who's coming", "{{{ESTIMATOR}}}")}${fact("Where", "{{{ADDRESS}}}", true)}`,
    ),
    sublineRow(
      `<strong style="color:${INK};">One thing that helps us:</strong> please make sure we can get to every room and area we'll be moving items from, including any loft, garage or outbuildings.`,
      "0 36px 16px",
    ),
    sublineRow(
      `At the visit we'll <strong style="color:${INK};">email your written fixed price to you on the spot</strong>. We take real care to get it right; it's provided subject to our terms and conditions.`,
      "0 36px 16px",
    ),
    sublineRow(
      `Need to change the time? Just call <strong style="color:${ACCENT};">${PHONE}</strong> or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const quoteEmailHtml = shellHtml(
  `Your fixed price from ${B.name}: {{{GRAND_TOTAL}}}. PDF attached.`,
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Your fixed price."),
    sublineRow("{{{QUOTE_INTRO}}}"),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7E4DE;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="padding:22px 26px;border-left:4px solid ${ACCENT};">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#8A857E;margin-bottom:6px;">Total move cost</div>
          <div style="font-family:${FONT_STACK};font-size:40px;font-weight:300;color:${INK};letter-spacing:-0.02em;line-height:1;">{{{GRAND_TOTAL}}}</div>
          <div style="font-size:11px;color:#8A857E;margin-top:8px;">{{{TOTAL_COST_NOTE}}}</div>
        </td>
        <td align="right" valign="middle" style="padding:22px 26px;border-left:1px solid #EAE7E2;width:150px;">
          <div style="font-size:10px;color:#8A857E;text-transform:uppercase;letter-spacing:0.18em;">Valid until</div>
          <div style="font-size:14px;color:${INK};font-weight:700;margin-top:4px;">{{{EXPIRY_DATE}}}</div>
        </td>
      </tr>
    </table>
  </td></tr>`,
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#8A857E;margin-bottom:10px;">Job at a glance</div>
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top" style="width:46%;">
            <div style="font-size:10px;color:#8A857E;letter-spacing:0.1em;text-transform:uppercase;">Collection</div>
            <div style="font-size:13px;color:${INK};font-weight:600;margin-top:4px;line-height:1.45;">{{{COLLECTION_HTML}}}</div>
          </td>
          <td align="center" valign="middle" style="width:8%;font-size:18px;color:${ACCENT};font-weight:600;">&rarr;</td>
          <td valign="top" style="width:46%;">
            <div style="font-size:10px;color:#8A857E;letter-spacing:0.1em;text-transform:uppercase;">Destination</div>
            <div style="font-size:13px;color:${INK};font-weight:600;margin-top:4px;line-height:1.45;">{{{DESTINATION_HTML}}}</div>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid #EAE7E2;padding-top:14px;"><tr>
          <td style="width:34%;font-size:11px;color:#8A857E;vertical-align:top;"><div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Date</div><div style="color:${INK};font-weight:600;margin-top:2px;">{{{MOVE_DATE_GLANCE}}}</div></td>
          <td style="width:33%;font-size:11px;color:#8A857E;vertical-align:top;"><div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Vehicle</div><div style="color:${INK};font-weight:600;margin-top:2px;">{{{VEHICLE}}}</div></td>
          <td style="width:33%;font-size:11px;color:#8A857E;vertical-align:top;"><div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Packing</div><div style="color:${INK};font-weight:600;margin-top:2px;">{{{PACKING}}}</div></td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>`,
    linkButton("Accept your quote online&nbsp;&rarr;", "{{{ACCEPT_URL}}}"),
    `  <tr><td align="center" style="padding:0 36px 22px;">
    <p style="font-size:11px;color:#9CA3AF;margin:0;">Prefer email? <a href="{{{REPLY_HREF}}}" style="color:#8A857E;">Reply to confirm</a> instead.</p>
  </td></tr>`,
    stepsRow([
      // Policy v2 truth (Peter, 2026-08-16): the deposit secures the BOOKING;
      // the date is only reserved at the separate confirm-your-date step (25%).
      { t: "Accept your quote", d: "About 30 seconds, and your price is locked in." },
      { t: "Pay your {{{DEPOSIT_AMOUNT}}} deposit", d: B.quoteDepositStepDesc },
      { t: "Before &amp; on the day", d: "Balance due 24 hours before moving day, then we arrive on time and get you moved." },
    ]),
    sublineRow(
      `<strong style="color:${INK};">Included, free:</strong> your survey, packing boxes, furniture &amp; wardrobe boxes, and full insurance. Just tell us if you'd like <strong style="color:${INK};">boxes</strong> dropped off, and if anything needs special care (wardrobe boxes, chair covers), your estimator will already have flagged it.`,
      "0 36px 18px",
    ),
    sublineRow(
      `Any changes, call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} or reply to this email.`,
      "0 36px 8px",
    ),
    signoffRow(),
    `  <tr><td style="padding:0 36px 24px;">
    <div style="font-size:10px;color:#9CA3AF;line-height:1.5;">Issued {{{ISSUED_DATE}}} &middot; valid 30 days &middot; ref {{{QUOTE_REF}}}. Your price is fixed, provided subject to our terms and conditions.</div>
  </td></tr>`,
  ].join("\n"),
);

const depositReceivedHtml = shellHtml(
  "We've received your {{{AMOUNT}}} deposit. Your move date is secured.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow(`Thank you for booking with ${B.name}.`),
    sublineRow(
      `We've received your <strong style="color:${INK};">{{{AMOUNT}}}</strong> deposit for your move on <strong style="color:${INK};">{{{MOVE_DATE_LABEL}}}</strong>. Your date and crew are now secured.`,
    ),
    amountCard("Deposit paid", "{{{AMOUNT}}}"),
    sublineRow("{{{BALANCE_LINE}}}", "0 36px 16px"),
    ...fleetNoteRows,
    sublineRow(
      "If we need anything from you beforehand we'll be in touch. Otherwise, rest assured we'll see you on the day. In the meantime, just let us know if you'd like any <strong style=\"color:" + INK + ';">boxes</strong> dropped off.',
      "0 36px 16px",
    ),
    sublineRow(
      `Any questions, call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const balanceInvoiceHtml = shellHtml(
  "Your final balance of {{{AMOUNT}}} is due 24 hours before your move.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Your final balance."),
    sublineRow(
      "Ahead of your move{{{MOVE_DATE_CLAUSE}}}, here's the balance to settle. Payment in full is due <strong style=\"color:" + INK + ';">24 hours before your move</strong> (unless we\'ve agreed otherwise), so everything\'s squared away and the crew can focus on the day.',
    ),
    amountCard("Balance due{{{INVOICE_META}}}", "{{{AMOUNT}}}", "Your {{{QUOTE_REF}}} deposit is already deducted."),
    "{{{INVOICE_BUTTON}}}",
    // The balance rail takes no online card — bank transfer, phone card or cash.
    // This used to render the deposit rail's block, which told the customer
    // "Card via the button above" while the button above is "View your invoice"
    // on an invoice raised with disableOnlinePayments (see the note by
    // bankOnlyCard). The commitment template already uses this one.
    bankOnlyCard("{{{QUOTE_REF}}}"),
    ...fleetNoteRows,
    sublineRow(
      `Already paid, or need a different arrangement? Call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const balanceReceivedHtml = shellHtml(
  "Balance of {{{AMOUNT}}} received. You're all set for move day.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("All settled. Thank you."),
    sublineRow(
      `We've received your balance of <strong style="color:${INK};">{{{AMOUNT}}}</strong>, so there's nothing more to pay. Everything's in order for your move on <strong style="color:${INK};">{{{MOVE_DAY_LABEL}}}</strong>, and we look forward to seeing you then.`,
    ),
    sublineRow(
      `Any last-minute questions, call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const completionCertificateHtml = shellHtml(
  `Your move with ${B.name} is complete. Your certificate is attached.`,
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("That's your move complete."),
    sublineRow(
      "Your move on <strong style=\"color:" + INK + ';">{{{MOVE_DATE_LABEL}}}</strong> is all done, and we genuinely can\'t thank you enough for choosing ' + B.name + '. We know moving is a big deal and that you had plenty of choice; it really does mean a lot that you trusted us with it.',
    ),
    sublineRow("Your <strong style=\"color:" + INK + ';">completion certificate is attached</strong> for your records.', "0 36px 18px"),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F4;border-radius:8px;"><tr><td style="padding:16px 22px;border-left:4px solid ${ACCENT};">
      <p style="margin:0;font-size:13px;color:${INK_SOFT};line-height:1.6;">{{{STATUS_LINE}}}</p>
    </td></tr></table>
  </td></tr>`,
    sublineRow(
      `If anything comes up at all, just reply to this email or call <strong style="color:${ACCENT};">the team</strong> on ${PHONE}. We're always happy to help.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const reviewRequestHtml = shellHtml(
  `Thank you for moving with ${B.name}. A quick review means a lot.`,
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("How did we do?"),
    sublineRow(
      "That's your move done, and thank you, genuinely, for choosing " + B.name + ". It really does mean a lot to a small local firm like ours, and we're grateful you trusted us with your move.",
    ),
    sublineRow(
      `If ${B.reviewCrewPhrase} looked after you well, a quick <strong style="color:${INK};">{{{REVIEW_PLATFORM}}}</strong> review would make a real difference. It only takes a minute.`,
      "0 36px 20px",
    ),
    linkButton("Leave a {{{REVIEW_PLATFORM}}} review&nbsp;&rarr;", "{{{REVIEW_URL}}}"),
    sublineRow(
      `And if anything wasn't quite right, please reply to this email or call <strong style="color:${ACCENT};">the team</strong> on ${PHONE} first. We'd always rather put it right.`,
      "16px 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

/* ---- crew portal invite (internal — set-your-own-password link) ------------ */

const crewInviteHtml = shellHtml(
  "You've been added to the Marley Moves crew portal — set your password to sign in.",
  [
    greetRow("{{{CREW_FIRST_NAME}}}"),
    headlineRow("Set up your crew login."),
    sublineRow(
      `You've been added to the <strong style="color:${INK};">Marley Moves crew portal</strong>. Set your password to see your jobs, day sheets, availability and pay, all in one place.`,
    ),
    linkButton("Set your password&nbsp;&rarr;", "{{{SET_PASSWORD_URL}}}"),
    stepsRow([
      { t: "Set your password", d: "Choose a password using the button above." },
      { t: "Sign in", d: "Use your email and that password at ops.marleymoves.co.uk." },
      { t: "Add Face ID or fingerprint", d: "Turn on quick sign-in so you never type it again." },
    ]),
    sublineRow(
      `This link is just for you and expires in 7 days. If you weren't expecting it, ignore this email or call <strong style="color:${ACCENT};">${PHONE}</strong>.`,
      "0 36px 8px",
    ),
    signoffRow(),
  ].join("\n"),
);

/* ---- chase emails: personal, from the lead owner ({{{OWNER_NAME}}}) --------- */

const ownerSignoffRow = () => `  <tr><td style="padding:8px 36px 30px;">
    <p style="margin:0;font-size:14px;color:${INK};">Best regards,<br>{{{OWNER_NAME}}}</p>
  </td></tr>`;

// Chases render in the SAME shell + standard footer as the transactional emails
// (for consistency), with a personal owner sign-off and the accept link as a red
// button rather than a raw URL.
const chaseHtml = (preheader, { intro, cta = "Accept your quote online&nbsp;&rarr;", closing = [] }) =>
  shellHtml(
    preheader,
    [
      greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
      ...intro.map((p, i) => sublineRow(p, i === 0 ? "8px 36px 14px" : "0 36px 14px")),
      linkButton(cta, "{{{ACCEPT_LINK}}}"),
      ...closing.map((p) => sublineRow(p, "14px 36px 8px")),
      ownerSignoffRow(),
    ].join("\n"),
  );

const CHASE_FROM = B.helloFrom;
const CHASE_VARS = [
  { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
  { key: "OWNER_NAME", type: "string", fallback_value: B.signoff },
  { key: "QUOTE_REF", type: "string", fallback_value: "your quote" },
  { key: "ACCEPT_LINK", type: "string", fallback_value: B.quoteLinkFallback },
  { key: "EXPIRY_DATE", type: "string", fallback_value: "the expiry date on your quote" },
  { key: "DEPOSIT_AMOUNT", type: "string", fallback_value: "£100" },
];

/** The registry: PATCH-by-name keeps ids stable. envVar is what the panel reads. */
const TEMPLATES = [
  {
    name: "survey-confirmation",
    envVar: "RESEND_TEMPLATE_SURVEY_CONFIRMATION",
    subject: "Your survey is booked: {{{DATE_LABEL}}}, {{{TIME_LABEL}}}",
    from: B.helloFrom,
    reply_to: B.email,
    html: surveyConfirmationHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "DATE_LABEL", type: "string", fallback_value: "your booked date" },
      { key: "TIME_LABEL", type: "string", fallback_value: "the agreed time" },
      { key: "ESTIMATOR", type: "string", fallback_value: "One of our team" },
      { key: "ADDRESS", type: "string", fallback_value: "your address" },
    ],
  },
  {
    name: "quote-email",
    envVar: "RESEND_TEMPLATE_QUOTE_EMAIL",
    subject: `Your removal quote from ${B.name} ({{{QUOTE_REF}}})`,
    from: B.helloFrom,
    html: quoteEmailHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your quote" },
      { key: "QUOTE_INTRO", type: "string", fallback_value: "Here is your fixed price for the move." },
      { key: "GRAND_TOTAL", type: "string", fallback_value: "the quoted total" },
      { key: "TOTAL_COST_NOTE", type: "string", fallback_value: "Includes admin fee" },
      { key: "EXPIRY_DATE", type: "string", fallback_value: "30 days from issue" },
      { key: "COLLECTION_HTML", type: "string", fallback_value: "—" },
      { key: "DESTINATION_HTML", type: "string", fallback_value: "—" },
      { key: "MOVE_DATE_GLANCE", type: "string", fallback_value: "TBC" },
      { key: "VEHICLE", type: "string", fallback_value: "—" },
      { key: "PACKING", type: "string", fallback_value: "—" },
      { key: "ACCEPT_URL", type: "string", fallback_value: B.quoteLinkFallback },
      { key: "REPLY_HREF", type: "string", fallback_value: "mailto:" + B.email },
      { key: "DEPOSIT_AMOUNT", type: "string", fallback_value: "£100" },
      { key: "ISSUED_DATE", type: "string", fallback_value: "today" },
    ],
  },
  {
    name: "deposit-received",
    envVar: "RESEND_TEMPLATE_DEPOSIT_RECEIVED",
    subject: "Deposit received. You're booked in ({{{QUOTE_REF}}})",
    from: B.helloFrom,
    html: depositReceivedHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your quote" },
      { key: "AMOUNT", type: "string", fallback_value: "your deposit" },
      { key: "MOVE_DATE_LABEL", type: "string", fallback_value: "your booked date" },
      {
        key: "BALANCE_LINE",
        type: "string",
        fallback_value:
          "Your remaining balance is due 24 hours before your move, unless we've agreed otherwise.",
      },
    ],
  },
  {
    name: "balance-invoice",
    envVar: "RESEND_TEMPLATE_BALANCE_INVOICE",
    subject: "Your final balance: {{{QUOTE_REF}}} ({{{AMOUNT}}})",
    from: B.helloFrom,
    html: balanceInvoiceHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your quote" },
      { key: "AMOUNT", type: "string", fallback_value: "the remaining balance" },
      { key: "MOVE_DATE_CLAUSE", type: "string", fallback_value: "" },
      { key: "INVOICE_META", type: "string", fallback_value: "" },
      { key: "INVOICE_BUTTON", type: "string", fallback_value: "" },
    ],
  },
  {
    name: "balance-received",
    envVar: "RESEND_TEMPLATE_BALANCE_RECEIVED",
    subject: "Payment received. All settled ({{{QUOTE_REF}}})",
    from: B.helloFrom,
    html: balanceReceivedHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your quote" },
      { key: "AMOUNT", type: "string", fallback_value: "your balance" },
      { key: "MOVE_DAY_LABEL", type: "string", fallback_value: "move day" },
    ],
  },
  {
    name: "completion-certificate",
    envVar: "RESEND_TEMPLATE_COMPLETION_CERT",
    subject: "Your move is complete. Certificate attached",
    from: B.helloFrom,
    reply_to: B.email,
    html: completionCertificateHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "MOVE_DATE_LABEL", type: "string", fallback_value: "your move date" },
      {
        key: "STATUS_LINE",
        type: "string",
        fallback_value: "Everything was signed off on the day with nothing to report.",
      },
    ],
  },
  {
    name: "review-request",
    envVar: "RESEND_TEMPLATE_REVIEW_REQUEST",
    subject: "How did we do, {{{CUSTOMER_FIRST_NAME}}}?",
    from: B.helloFrom,
    html: reviewRequestHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "REVIEW_PLATFORM", type: "string", fallback_value: "Google" },
      { key: "REVIEW_URL", type: "string", fallback_value: B.reviewUrlFallback },
    ],
  },
  {
    name: "crew-portal-invite",
    envVar: "RESEND_TEMPLATE_CREW_INVITE",
    subject: "Set up your Marley Moves crew login",
    from: B.helloFrom,
    reply_to: B.email,
    html: crewInviteHtml,
    variables: [
      { key: "CREW_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "SET_PASSWORD_URL", type: "string", fallback_value: "https://ops.marleymoves.co.uk/auth/set-password" },
    ],
  },
  {
    name: "chase-quote-1",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_1",
    subject: "Your removal quote: any questions, {{{CUSTOMER_FIRST_NAME}}}?",
    from: CHASE_FROM,
    html: chaseHtml("Just checking your quote reached you okay.", {
      intro: [
        "It's {{{OWNER_NAME}}} here. I wanted to make sure your quote ({{{QUOTE_REF}}}) reached you safely and to check whether you have any questions.",
        "If everything looks right, you can accept online in about 30 seconds and that reserves your date:",
      ],
      cta: "Accept your quote online&nbsp;&rarr;",
      closing: [`Anything you'd like adjusted, just reply to this email or call me on ${PHONE}.`],
    }),
    variables: CHASE_VARS,
  },
  {
    name: "chase-quote-2",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_2",
    subject: "Would you like me to hold your move date?",
    from: CHASE_FROM,
    html: chaseHtml("Shall I hold your move date?", {
      intro: [
        "Dates for the coming weeks are starting to fill up, with month-end and Fridays always going first, so I wanted to check where you're at with your quote.",
        "If your completion date isn't confirmed yet, that's completely normal. Most of our customers only have theirs two or three weeks before the move. Accepting now simply adds you to our priority list, so when your date does land we're best placed to accommodate it.",
        "Accepting takes about half a minute, and your {{{DEPOSIT_AMOUNT}}} deposit secures your place and your crew:",
      ],
      cta: "Accept your quote online&nbsp;&rarr;",
      closing: ["If anything in the quote doesn't look right, let me know and I'll sort it before anything is booked."],
    }),
    variables: CHASE_VARS,
  },
  {
    name: "chase-quote-3",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_3",
    // The only chase with no money in it, and a soft CTA. See the reasoning in
    // lib/quote/chase.ts quoteChaseEmail step 3 (Peter, 2026-08-11): after three
    // unanswered emails, another deposit figure reads as pressure on someone we
    // have never actually spoken to. Keep this template and that copy in step.
    subject: "Still here if you need anything, {{{CUSTOMER_FIRST_NAME}}}",
    from: CHASE_FROM,
    html: chaseHtml("No rush at all. Your quote is open until {{{EXPIRY_DATE}}}.", {
      intro: [
        "It's {{{OWNER_NAME}}} here, and this is the last reminder I'll send you, so I'll keep it brief.",
        `Your quote ({{{QUOTE_REF}}}) is open until {{{EXPIRY_DATE}}} and there's nothing you need to do before then. If anything has changed, a different date, more or less to move, or something you'd like me to look at again, just reply to this email or call me on ${PHONE}. I'd be glad to help.`,
      ],
      cta: "View your quote&nbsp;&rarr;",
      // No "all the best with the move" line here: the shell already signs off
      // with "Best regards, {{{OWNER_NAME}}}", and two farewells in a row is
      // exactly the padding that makes a short, warm note read like a mailshot.
      closing: [
        "And if you've made other arrangements, that's absolutely fine. Reply with \"not going ahead\" and I'll leave you in peace. If you have a moment, any feedback on your decision would genuinely help us improve.",
      ],
    }),
    variables: CHASE_VARS,
  },
  {
    name: "chase-deposit-1",
    envVar: "RESEND_TEMPLATE_CHASE_DEPOSIT_1",
    subject: "One last step to secure your booking ({{{QUOTE_REF}}})",
    from: CHASE_FROM,
    html: chaseHtml("One last step to secure your booking.", {
      intro: [
        "It's {{{OWNER_NAME}}} here. Great to have you booked in. The last step is your {{{DEPOSIT_AMOUNT}}} deposit, which makes everything official. Once it's in, we'll confirm your moving date with you to lock it in. If you're still waiting on completion, no problem, your booking is held with a fully amendable date. Either way, your price and your crew are secured.",
        B.chaseDeposit1PayLine,
      ],
      cta: "Pay your deposit&nbsp;&rarr;",
      closing: [`Any questions, just reply to this email or call me on ${PHONE}.`],
    }),
    variables: CHASE_VARS,
  },
  {
    name: "chase-deposit-2",
    envVar: "RESEND_TEMPLATE_CHASE_DEPOSIT_2",
    subject: "Your booking is still provisional ({{{QUOTE_REF}}})",
    from: CHASE_FROM,
    html: chaseHtml("Your booking is still provisional.", {
      intro: [
        "Just a friendly reminder that we're still holding your booking for you. Whenever you're ready, your {{{DEPOSIT_AMOUNT}}} deposit is what confirms your place and your crew. And if your date isn't settled yet, no problem at all. It stays fully amendable:",
      ],
      cta: "Pay your deposit&nbsp;&rarr;",
      closing: [
        "If your timing has changed or plans have shifted, just reply and let me know.",
        ...(B.depositChaseEntityLine ? [B.depositChaseEntityLine] : []),
      ],
    }),
    variables: CHASE_VARS,
  },

  /* ---- Payments Policy v2 (docs/payments-policy-v2-prd.md §5E) ------------ */
  {
    name: "date-confirmation",
    envVar: "RESEND_TEMPLATE_DATE_CONFIRMATION",
    subject: "Move date confirmed ({{{QUOTE_REF}}})",
    from: MONEY_FROM,
    html: dateConfirmationHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your booking" },
      { key: "MOVE_DATE_LABEL", type: "string", fallback_value: "your booked date" },
      { key: "DEPOSIT_AMOUNT", type: "string", fallback_value: "£100" },
      // Pre-rendered HTML block from lib/comms/date-confirm-email.ts —
      // commitment amount + invoice button + bank details, or the
      // zero-commitment "nothing more to pay right now" variant.
      { key: "COMMITMENT_BLOCK", type: "string", fallback_value: "" },
      {
        key: "HELD_POSITION_LINE",
        type: "string",
        fallback_value:
          "Amounts you have paid are held against your original date, and are refunded in full if the day is re-booked.",
      },
    ],
  },
  {
    name: "commitment-received",
    envVar: "RESEND_TEMPLATE_COMMITMENT_RECEIVED",
    subject: "Payment received: commitment for your move ({{{QUOTE_REF}}})",
    from: MONEY_FROM,
    html: commitmentReceivedHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your booking" },
      { key: "AMOUNT", type: "string", fallback_value: "your commitment payment" },
      { key: "MOVE_DATE_LABEL", type: "string", fallback_value: "your booked date" },
    ],
  },
  {
    name: "commitment-chase",
    envVar: "RESEND_TEMPLATE_COMMITMENT_CHASE",
    subject: "Your commitment payment is due {{{DUE_LABEL}}} ({{{QUOTE_REF}}})",
    from: MONEY_FROM,
    html: commitmentChaseHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your booking" },
      { key: "AMOUNT", type: "string", fallback_value: "your commitment payment" },
      { key: "DUE_LABEL", type: "string", fallback_value: "now" },
      { key: "MOVE_DATE_LABEL", type: "string", fallback_value: "your booked date" },
      // " · Invoice INV-000123" or "" — folds into the amount-card label.
      { key: "INVOICE_META", type: "string", fallback_value: "" },
      // Pre-rendered red "View your invoice" button row, or "".
      { key: "INVOICE_BUTTON", type: "string", fallback_value: "" },
      // The verbatim acknowledgment the customer signed (HTML-escaped by the
      // composer) — single source in lib/signatures.ts DATE_CONFIRM_ACKS.
      {
        key: "DATE_CONFIRM_ACK",
        type: "string",
        fallback_value: "the confirmation you signed when you confirmed your move date",
      },
    ],
  },
  {
    name: "cancellation-ack",
    envVar: "RESEND_TEMPLATE_CANCELLATION_ACK",
    subject: "Your move date has changed ({{{QUOTE_REF}}})",
    from: MONEY_FROM,
    html: cancellationAckHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your booking" },
      { key: "OLD_DATE_LABEL", type: "string", fallback_value: "your original date" },
      { key: "NEW_DATE_LABEL", type: "string", fallback_value: "your new date" },
      // Pre-composed "Already paid" amount card (full HTML fragment), or ""
      // when nothing has been paid — never render a £0 card.
      { key: "HELD_CARD", type: "string", fallback_value: "" },
      // The held/refund position sentences, composed per the fill rule.
      { key: "HELD_SENTENCES", type: "string", fallback_value: "" },
    ],
  },
  {
    name: "refund-executed",
    envVar: "RESEND_TEMPLATE_REFUND_EXECUTED",
    subject: `Your {{{TOTAL_REFUND}}} refund from ${B.name} ({{{QUOTE_REF}}})`,
    from: MONEY_FROM,
    html: refundExecutedHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your booking" },
      { key: "TOTAL_REFUND", type: "string", fallback_value: "full" },
      // Pre-rendered <tr> rows from lib/comms/refund-emails.ts lineRows() —
      // one per rail, each "label · rail" with its amount.
      { key: "REFUND_LINES", type: "string", fallback_value: "" },
      { key: "SLA_LINE", type: "string", fallback_value: B.refundSlaFallback },
    ],
  },
  {
    name: "retained-outcome",
    envVar: "RESEND_TEMPLATE_RETAINED_OUTCOME",
    subject: "An update on your booking ({{{QUOTE_REF}}})",
    from: MONEY_FROM,
    html: retainedOutcomeHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your booking" },
      // " of <strong>Friday 14 August</strong>" or "".
      { key: "ORIGINAL_DATE_CLAUSE", type: "string", fallback_value: "" },
      { key: "RETAINED_AMOUNT", type: "string", fallback_value: "part" },
      // Pre-rendered above-the-cap refund card + SLA line, or "".
      { key: "REFUND_SECTION", type: "string", fallback_value: "" },
    ],
  },
  {
    name: "marley-cancel-refund",
    envVar: "RESEND_TEMPLATE_MARLEY_CANCEL",
    subject: "We're sorry: your move is cancelled ({{{QUOTE_REF}}})",
    from: MONEY_FROM,
    html: marleyCancelHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your booking" },
      // " on <strong>Friday 14 August</strong>" or "".
      { key: "MOVE_DATE_CLAUSE", type: "string", fallback_value: "" },
      // Pre-composed "Refunded in full" amount card, or "" when nothing was
      // paid — never render a £0 card.
      { key: "REFUND_CARD", type: "string", fallback_value: "" },
      {
        key: "REFUND_SENTENCE",
        type: "string",
        fallback_value:
          "Everything you've paid comes back to you in full, the same way you paid it. There's nothing you need to do.",
      },
    ],
  },
  {
    name: "date-change-confirmation",
    envVar: "RESEND_TEMPLATE_DATE_CHANGE_CONFIRMATION",
    subject: "Your new move date is confirmed: {{{NEW_DATE_LABEL}}} ({{{QUOTE_REF}}})",
    from: MONEY_FROM,
    html: dateChangeConfirmationHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your booking" },
      { key: "OLD_DATE_LABEL", type: "string", fallback_value: "your original date" },
      { key: "NEW_DATE_LABEL", type: "string", fallback_value: "your new date" },
      // Pre-composed "Already paid" amount card, or "" when nothing paid.
      { key: "HELD_CARD", type: "string", fallback_value: "" },
      // "You've paid £X and it all still counts towards your move." or "".
      { key: "HELD_SENTENCE", type: "string", fallback_value: "" },
      // Unpaid-commitment restatement ("…moves with your date…") or "".
      { key: "COMMITMENT_SENTENCE", type: "string", fallback_value: "" },
    ],
  },
];

  // Group comms (PRD §11.10) keep Marley's identity: the crew portal invite is
  // never cloned into another brand's set. Only the NAME takes the prefix —
  // that is what Resend displays and what the PATCH-by-name matcher matches on.
  // envVar is deliberately left alone and stays the single lookup key, so the
  // ids this run records land under exactly what templateIdFor resolves.
  return TEMPLATES.filter((t) => B.includeCrewInvite || t.name !== "crew-portal-invite").map((t) => ({
    ...t,
    name: B.namePrefix + t.name,
  }));
}

const TEMPLATES = buildTemplateSet(B);

/* ---------------------------------------------------------------- preview */

if (PREVIEW_DIR) {
  const directory = resolve(PREVIEW_DIR);
  const previewValues = {
    CUSTOMER_FIRST_NAME: "Sarah",
    OWNER_NAME: "Luke",
    QUOTE_REF: "MM-260713-004",
    QUOTE_INTRO: "Thanks for having us round earlier. Here is your written fixed price for the move.",
    ACCEPT_LINK: "https://ops.marleymoves.co.uk/q/example",
    ACCEPT_URL: "https://ops.marleymoves.co.uk/q/example",
    EXPIRY_DATE: "12 August 2026",
    AMOUNT: "£1,245.00",
    GRAND_TOTAL: "£1,845.00",
    TOTAL_COST_NOTE: "Fixed price, all inclusive",
    DEPOSIT_AMOUNT: "£100",
    ISSUED_DATE: "13 July 2026",
    MOVE_DATE_LABEL: "Saturday 26 July",
    MOVE_DAY_LABEL: "Saturday 26 July",
    MOVE_DATE_CLAUSE: " on Saturday 26 July",
    MOVE_DATE_GLANCE: "26 July 2026",
    DATE_LABEL: "Thursday 17 July",
    TIME_LABEL: "2:00pm",
    ESTIMATOR: "Luke",
    ADDRESS: "12 High Street, Shaftesbury, SP7 8JE",
    COLLECTION_HTML: "12 High Street<br>Shaftesbury, SP7",
    DESTINATION_HTML: "8 Station Road<br>Salisbury, SP2",
    VEHICLE: "Large removal van",
    PACKING: "Customer packed",
    REPLY_HREF: "mailto:hello@marleymoves.co.uk",
    BALANCE_LINE: "Your remaining balance of £1,245.00 is due 24 hours before your move, unless we've agreed otherwise.",
    INVOICE_META: " · due 25 July",
    INVOICE_BUTTON: "",
    STATUS_LINE: "Everything was signed off on the day with nothing to report.",
    REVIEW_PLATFORM: "Google",
    REVIEW_URL: "https://search.google.com/local/writereview?placeid=example",
    // Per-brand sample values (ref shape, owner, reply address) — marley's are
    // empty so the block above stays the exact original render input.
    ...B.previewOverrides,
  };
  await mkdir(directory, { recursive: true });
  for (const template of ONLY ? TEMPLATES.filter((t) => ONLY.has(t.name)) : TEMPLATES) {
    const fallbacks = Object.fromEntries(
      (template.variables ?? []).map((variable) => [variable.key, String(variable.fallback_value ?? "")]),
    );
    const values = { ...fallbacks, ...previewValues };
    const html = template.html.replace(/\{\{\{([A-Z0-9_]+)\}\}\}/g, (_match, key) => values[key] ?? key);
    await writeFile(resolve(directory, `${template.name}.html`), html, "utf8");
  }
  console.log(`Rendered ${TEMPLATES.length} template previews to ${directory}`);
  process.exit(0);
}

/* ---------------------------------------------------------------- api */

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.message || JSON.stringify(json)}`);
  return json;
}

// ?limit=100: the default page size is 20, which silently hid the 20th+
// template and made the create-or-update matcher DUPLICATE it (bit us
// 2026-07-29 with survey-confirmation). One page of 100 covers us for a long
// time; if we ever exceed it, has_more turns true and the guard below throws.
const listing = await api("GET", "/templates?limit=100").catch(() => ({ data: [], has_more: false }));
if (listing.has_more) throw new Error("More than 100 templates — add real pagination before running.");
const existing = listing.data ?? [];
const byName = new Map(existing.map((t) => [t.name, t]));

const SELECTED = ONLY ? TEMPLATES.filter((t) => ONLY.has(t.name)) : TEMPLATES;
if (ONLY && SELECTED.length === 0) {
  console.error(`--only matched nothing. Known names: ${TEMPLATES.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

// Trap-4 hard guard (PRD §11.7): a non-marley run may only ever PATCH names
// carrying its own prefix — an unprefixed name here would overwrite a live
// Marley template. Belt and braces on top of the prefixing in buildTemplateSet.
if (B.namePrefix) {
  const unprefixed = SELECTED.filter((t) => !t.name.startsWith(B.namePrefix));
  if (unprefixed.length > 0) {
    console.error(`Refusing to push for '${BRAND}': unprefixed template names ${unprefixed.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }
}

// envVar is the key the ids are recorded under, so a template missing one would
// store its id at "undefined" and that brand's send would resolve nothing for
// the rest of its life — silently, since a missed lookup degrades to inline
// HTML rather than erroring. Refuse the push instead of printing a broken map.
const unkeyed = SELECTED.filter((t) => !t.envVar);
if (unkeyed.length > 0) {
  console.error(`Refusing to push: no envVar on ${unkeyed.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

// Resend enforces declared-variables ≡ html-variables at every moment, so an
// in-place PATCH that changes the variable SET is rejected. So: try PATCH first
// (keeps the id — no env re-wire for copy/design-only edits); only if that fails
// (a variable was added/removed) delete + recreate (new id). The loop prints an
// env line for each — apply any that changed to the app env.
const envLines = [];
const idsByKey = {};
for (const t of SELECTED) {
  const { envVar, ...def } = t;
  const old = byName.get(t.name)?.id;
  let id = old;
  if (old) {
    try {
      await api("PATCH", `/templates/${old}`, def);
      console.log(`updated  ${t.name} (${old})`);
    } catch {
      await api("DELETE", `/templates/${old}`).catch(() => {});
      id = (await api("POST", "/templates", def)).id;
      console.log(`recreated ${t.name} (${id}) [was ${old}]`);
    }
  } else {
    id = (await api("POST", "/templates", def)).id;
    console.log(`created  ${t.name} (${id})`);
  }
  await api("POST", `/templates/${id}/publish`).catch((e) => {
    console.warn(`  publish failed (${e.message}) — publish "${t.name}" in the dashboard.`);
  });
  if (envVar && !B.namePrefix) envLines.push(`${envVar}=${id}`);
  idsByKey[envVar] = id;
}
if (B.namePrefix) {
  // Id capture (PRD §3.5): paste this JSON into brands.resend_template_ids —
  // the exact update statement is documented in the header comment. Keys are
  // the env-var names templateIdFor(brand, envName) resolves.
  console.log(`\n--- brands.resend_template_ids for '${BRAND}' ---`);
  console.log(JSON.stringify(idsByKey, null, 2));
} else {
  console.log("\n--- env (set these on the app) ---");
  for (const line of envLines) console.log(line);
}
console.log("done");
