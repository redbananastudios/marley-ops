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
 *
 * Idempotent: matches templates by name; existing ones are updated (PATCH) and
 * republished, so the template ids never change (no env re-wiring needed).
 *
 * The everyday MARLEY_RESEND_API_KEY works here (verified 2026-07-13 — it has
 * full template read/write). Without a key you can still --preview-dir.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const previewArg = process.argv.indexOf("--preview-dir");
const PREVIEW_DIR = previewArg >= 0 ? process.argv[previewArg + 1] : null;

const KEY = process.env.RESEND_FULL_API_KEY || process.env.MARLEY_RESEND_FULL_API_KEY || process.env.MARLEY_RESEND_API_KEY;
if (!KEY && !PREVIEW_DIR) {
  console.error("Set RESEND_FULL_API_KEY (or MARLEY_RESEND_API_KEY) for the Marley Resend team.");
  process.exit(1);
}

const API = "https://api.resend.com";
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

/* ================================================================ house style */

const LOGO_URL = "https://marleymoves.co.uk/logo.png";
const FONT_STACK = "'Montserrat','Segoe UI',Helvetica,Arial,sans-serif";
const FONT_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&display=swap" rel="stylesheet">';
const RED = "#C03838";
const INK = "#1A1A1A";
const INK_SOFT = "#5A554F";

// Standard footer on EVERY email. Legal name MarleyMoves Ltd (one word); brand
// "Marley Moves" (space) stays in body copy + team sign-off.
const STANDARD_FOOTER = `  <tr><td style="padding:26px 36px;border-top:1px solid #EAE7E2;">
    <p style="margin:0;font-size:11px;line-height:1.85;color:#8A857E;text-align:center;">
      <strong style="color:#5A554F;">MarleyMoves Ltd</strong> &middot; Company No. 15914266 &middot; VAT 520 2213 58<br>
      Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX<br>
      <a href="tel:01747637070" style="color:#8A857E;text-decoration:none;">01747 637070</a> &middot; <a href="mailto:hello@marleymoves.co.uk" style="color:#8A857E;text-decoration:none;">hello@marleymoves.co.uk</a> &middot; <a href="https://marleymoves.co.uk" style="color:#8A857E;text-decoration:none;">marleymoves.co.uk</a><br>
      Fully insured &mdash; Public Liability up to &pound;2.5m &middot; Goods in Transit up to &pound;50k<br>
      Registered in England &amp; Wales &middot; <a href="https://marleymoves.co.uk/terms-conditions" style="color:#8A857E;text-decoration:underline;">Terms</a> &middot; <a href="https://marleymoves.co.uk/privacy-policy" style="color:#8A857E;text-decoration:underline;">Privacy</a>
    </p>
  </td></tr>`;

const shellHtml = (preheader, inner) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marley Moves</title>${FONT_LINK}</head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:${FONT_STACK};color:${INK};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">${preheader}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 22px;border-bottom:1px solid #EFECE7;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="200" style="display:block;margin:0 auto;height:auto;max-width:64%;border:0;outline:none;text-decoration:none;">
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
    <p style="margin:0;font-size:14px;color:${INK};">The Marley Moves Team</p>
  </td></tr>`;

const fact = (label, value, last = false) => `
      <tr>
        <td style="padding:10px 0;${last ? "" : "border-bottom:1px solid #F0EDE8;"}font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:38%;">${label}</td>
        <td style="padding:10px 0;${last ? "" : "border-bottom:1px solid #F0EDE8;"}font-size:14px;color:${INK};font-weight:600;">${value}</td>
      </tr>`;
const factsCard = (rows) => `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7E4DE;border-radius:8px;overflow:hidden;"><tr><td style="padding:16px 24px;border-left:4px solid ${RED};">
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    </td></tr></table>
  </td></tr>`;

const stepsRow = (steps) => `  <tr><td style="padding:4px 36px 22px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${RED};margin-bottom:16px;">What happens next</div>
    <table width="100%" cellpadding="0" cellspacing="0">${steps
      .map(
        (s, i) => `<tr>
      <td valign="top" width="40" style="padding:0 12px 16px 0;"><table cellpadding="0" cellspacing="0"><tr><td width="28" height="28" align="center" valign="middle" bgcolor="${RED}" style="width:28px;height:28px;border-radius:50%;font-size:13px;font-weight:700;color:#FFFFFF;font-family:${FONT_STACK};">${i + 1}</td></tr></table></td>
      <td valign="top" style="padding:0 0 16px;font-size:14px;color:${INK_SOFT};line-height:1.5;"><strong style="color:${INK};font-weight:600;">${s.t}</strong><br>${s.d}</td>
    </tr>`,
      )
      .join("")}</table>
  </td></tr>`;

const linkButton = (label, href) => `  <tr><td align="center" style="padding:2px 36px 10px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${RED}" style="border-radius:8px;">
      <a href="${href}" style="display:inline-block;padding:16px 36px;background:${RED};color:#FFFFFF;font-size:14.5px;font-weight:600;text-decoration:none;border-radius:8px;letter-spacing:0.02em;white-space:nowrap;font-family:${FONT_STACK};">${label}</a>
    </td></tr></table>
  </td></tr>`;

const amountCard = (label, amount, note) => `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7E4DE;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${RED};">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#8A857E;margin-bottom:6px;">${label}</div>
        <div style="font-family:${FONT_STACK};font-size:34px;font-weight:300;color:${INK};letter-spacing:-0.02em;line-height:1;">${amount}</div>${
          note ? `\n        <div style="font-size:11px;color:#8A857E;margin-top:8px;">${note}</div>` : ""
        }
      </td></tr>
    </table>
  </td></tr>`;

const paymentCard = (reference) => {
  const row = (l, v, last) => `<tr>
    <td style="padding:8px 0;${last ? "" : "border-bottom:1px solid #F0EDE8;"}font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:42%;">${l}</td>
    <td style="padding:8px 0;${last ? "" : "border-bottom:1px solid #F0EDE8;"}font-size:14px;color:${INK};font-weight:600;">${v}</td>
  </tr>`;
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F4;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#8A857E;margin-bottom:4px;">How to pay</div>
        <div style="font-size:12.5px;color:${INK_SOFT};line-height:1.55;margin-bottom:12px;">Bank transfer, card or cash &mdash; whichever suits. Card via the button above; bank details below.</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row("Account name", "MARLEYMOVES LTD")}
          ${row("Sort code", "04-00-03")}
          ${row("Account number", "12787423")}
          <tr>
            <td style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Reference</td>
            <td style="padding:8px 0;font-size:14px;color:${RED};font-weight:700;">${reference}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;
};

/* ================================================================= templates */

const surveyConfirmationHtml = shellHtml(
  "Your free home survey with Marley Moves is booked for {{{DATE_LABEL}}} at {{{TIME_LABEL}}}.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("You're booked in."),
    sublineRow(
      `Thanks &mdash; your <strong style="color:${INK};">free</strong> home survey is in the diary. {{{ESTIMATOR}}} will come and take a proper look at your move so we can give you an accurate, written fixed price. It won't take long &mdash; usually well under an hour.`,
    ),
    factsCard(
      `${fact("When", "{{{DATE_LABEL}}} at {{{TIME_LABEL}}}")}${fact("Who's coming", "{{{ESTIMATOR}}}")}${fact("Where", "{{{ADDRESS}}}", true)}`,
    ),
    sublineRow(
      `<strong style="color:${INK};">One thing that helps us:</strong> please make sure we can get to every room and area we'll be moving items from &mdash; including any loft, garage or outbuildings.`,
      "0 36px 16px",
    ),
    sublineRow(
      `At the visit we'll <strong style="color:${INK};">email your written fixed price to you on the spot</strong>. We take real care to get it right; it's provided subject to our terms and conditions.`,
      "0 36px 16px",
    ),
    sublineRow(
      `Need to change the time? Just call <strong style="color:${RED};">01747 637070</strong> or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const quoteEmailHtml = shellHtml(
  "Your fixed price from Marley Moves: {{{GRAND_TOTAL}}}. PDF attached.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Your fixed price."),
    sublineRow("{{{QUOTE_INTRO}}}"),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7E4DE;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="padding:22px 26px;border-left:4px solid ${RED};">
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
          <td align="center" valign="middle" style="width:8%;font-size:18px;color:${RED};font-weight:600;">&rarr;</td>
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
      { t: "Accept your quote", d: "About 30 seconds, and your date is reserved." },
      { t: "Pay your {{{DEPOSIT_AMOUNT}}} deposit", d: "Card or bank transfer &mdash; this locks your booking in." },
      { t: "Before &amp; on the day", d: "Balance due 24 hours before moving day, then we arrive on time and get you moved." },
    ]),
    sublineRow(
      `<strong style="color:${INK};">Included, free:</strong> your survey, packing boxes, furniture &amp; wardrobe boxes, and full insurance. Just tell us if you'd like <strong style="color:${INK};">boxes</strong> dropped off &mdash; and if anything needs special care (wardrobe boxes, chair covers), your estimator will already have flagged it.`,
      "0 36px 18px",
    ),
    sublineRow(
      `Any changes, call <strong style="color:${RED};">the team</strong> on 01747 637070 or reply to this email.`,
      "0 36px 8px",
    ),
    signoffRow(),
    `  <tr><td style="padding:0 36px 24px;">
    <div style="font-size:10px;color:#9CA3AF;line-height:1.5;">Issued {{{ISSUED_DATE}}} &middot; valid 30 days &middot; ref {{{QUOTE_REF}}}. Your price is fixed, provided subject to our terms and conditions.</div>
  </td></tr>`,
  ].join("\n"),
);

const depositReceivedHtml = shellHtml(
  "We've received your {{{AMOUNT}}} deposit &mdash; your move date is secured.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("Thank you for booking with Marley Moves."),
    sublineRow(
      `We've received your <strong style="color:${INK};">{{{AMOUNT}}}</strong> deposit for your move on <strong style="color:${INK};">{{{MOVE_DATE_LABEL}}}</strong> &mdash; your date and crew are now secured.`,
    ),
    amountCard("Deposit paid", "{{{AMOUNT}}}"),
    sublineRow("{{{BALANCE_LINE}}}", "0 36px 16px"),
    sublineRow(
      "If we need anything from you beforehand we'll be in touch &mdash; otherwise, rest assured we'll see you on the day. In the meantime, just let us know if you'd like any <strong style=\"color:" + INK + ';">boxes</strong> dropped off.',
      "0 36px 16px",
    ),
    sublineRow(
      `Any questions, call <strong style="color:${RED};">the team</strong> on 01747 637070 or reply to this email.`,
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
    paymentCard("{{{QUOTE_REF}}}"),
    sublineRow(
      `Already paid, or need a different arrangement? Call <strong style="color:${RED};">the team</strong> on 01747 637070 or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const balanceReceivedHtml = shellHtml(
  "Balance of {{{AMOUNT}}} received &mdash; you're all set for move day.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("All settled &mdash; thank you."),
    sublineRow(
      `We've received your balance of <strong style="color:${INK};">{{{AMOUNT}}}</strong>, so there's nothing more to pay. Everything's in order for your move on <strong style="color:${INK};">{{{MOVE_DAY_LABEL}}}</strong>, and we look forward to seeing you then.`,
    ),
    sublineRow(
      `Any last-minute questions, call <strong style="color:${RED};">the team</strong> on 01747 637070 or reply to this email.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const completionCertificateHtml = shellHtml(
  "Your move with Marley Moves is complete &mdash; your certificate is attached.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("That's your move complete."),
    sublineRow(
      "Your move on <strong style=\"color:" + INK + ';">{{{MOVE_DATE_LABEL}}}</strong> is all done &mdash; and we genuinely can\'t thank you enough for choosing Marley Moves. We know moving is a big deal and that you had plenty of choice; it really does mean a lot that you trusted us with it.',
    ),
    sublineRow("Your <strong style=\"color:" + INK + ';">completion certificate is attached</strong> for your records.', "0 36px 18px"),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F4;border-radius:8px;"><tr><td style="padding:16px 22px;border-left:4px solid ${RED};">
      <p style="margin:0;font-size:13px;color:${INK_SOFT};line-height:1.6;">{{{STATUS_LINE}}}</p>
    </td></tr></table>
  </td></tr>`,
    sublineRow(
      `If anything comes up at all, just reply to this email or call <strong style="color:${RED};">the team</strong> on 01747 637070 &mdash; we're always happy to help.`,
      "0 36px 6px",
    ),
    signoffRow(),
  ].join("\n"),
);

const reviewRequestHtml = shellHtml(
  "Thank you for moving with Marley Moves. A quick review means a lot.",
  [
    greetRow("{{{CUSTOMER_FIRST_NAME}}}"),
    headlineRow("How did we do?"),
    sublineRow(
      "That's your move done &mdash; and thank you, genuinely, for choosing Marley Moves. It really does mean a lot to a small local firm like ours, and we're grateful you trusted us with your move.",
    ),
    sublineRow(
      `If Connor and the crew looked after you well, a quick <strong style="color:${INK};">{{{REVIEW_PLATFORM}}}</strong> review would make a real difference &mdash; it only takes a minute.`,
      "0 36px 20px",
    ),
    linkButton("Leave a {{{REVIEW_PLATFORM}}} review&nbsp;&rarr;", "{{{REVIEW_URL}}}"),
    sublineRow(
      `And if anything wasn't quite right, please reply to this email or call <strong style="color:${RED};">the team</strong> on 01747 637070 first &mdash; we'd always rather put it right.`,
      "16px 36px 6px",
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

const CHASE_FROM = "Marley Moves <hello@marleymoves.co.uk>";
const CHASE_VARS = [
  { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
  { key: "OWNER_NAME", type: "string", fallback_value: "The Marley Moves Team" },
  { key: "QUOTE_REF", type: "string", fallback_value: "your quote" },
  { key: "ACCEPT_LINK", type: "string", fallback_value: "https://marleymoves.co.uk/quote/" },
  { key: "EXPIRY_DATE", type: "string", fallback_value: "the expiry date on your quote" },
  { key: "DEPOSIT_AMOUNT", type: "string", fallback_value: "£100" },
];

/** The registry: PATCH-by-name keeps ids stable. envVar is what the panel reads. */
const TEMPLATES = [
  {
    name: "survey-confirmation",
    envVar: "RESEND_TEMPLATE_SURVEY_CONFIRMATION",
    subject: "Your survey is booked — {{{DATE_LABEL}}}, {{{TIME_LABEL}}}",
    from: "Marley Moves <hello@marleymoves.co.uk>",
    reply_to: "hello@marleymoves.co.uk",
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
    subject: "Your removal quote from Marley Moves — {{{QUOTE_REF}}}",
    from: "Marley Moves <hello@marleymoves.co.uk>",
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
      { key: "ACCEPT_URL", type: "string", fallback_value: "https://marleymoves.co.uk/quote/" },
      { key: "REPLY_HREF", type: "string", fallback_value: "mailto:hello@marleymoves.co.uk" },
      { key: "DEPOSIT_AMOUNT", type: "string", fallback_value: "£100" },
      { key: "ISSUED_DATE", type: "string", fallback_value: "today" },
    ],
  },
  {
    name: "deposit-received",
    envVar: "RESEND_TEMPLATE_DEPOSIT_RECEIVED",
    subject: "Deposit received — you're booked in ({{{QUOTE_REF}}})",
    from: "Marley Moves <hello@marleymoves.co.uk>",
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
    subject: "Your final balance — {{{QUOTE_REF}}} ({{{AMOUNT}}})",
    from: "Marley Moves <hello@marleymoves.co.uk>",
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
    subject: "Payment received — all settled ({{{QUOTE_REF}}})",
    from: "Marley Moves <hello@marleymoves.co.uk>",
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
    subject: "Your move is complete — certificate attached",
    from: "Marley Moves <hello@marleymoves.co.uk>",
    reply_to: "hello@marleymoves.co.uk",
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
    from: "Marley Moves <hello@marleymoves.co.uk>",
    html: reviewRequestHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "REVIEW_PLATFORM", type: "string", fallback_value: "Google" },
      {
        key: "REVIEW_URL",
        type: "string",
        fallback_value: "https://g.page/r/CXD_Yh4RUF1cEBM/review",
      },
    ],
  },
  {
    name: "chase-quote-1",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_1",
    subject: "Your removal quote — any questions, {{{CUSTOMER_FIRST_NAME}}}?",
    from: CHASE_FROM,
    html: chaseHtml("Just checking your quote reached you okay.", {
      intro: [
        "It's {{{OWNER_NAME}}} here. I wanted to make sure your quote ({{{QUOTE_REF}}}) reached you safely and to check whether you have any questions.",
        "If everything looks right, you can accept online in about 30 seconds and that reserves your date:",
      ],
      cta: "Accept your quote online&nbsp;&rarr;",
      closing: ["Anything you'd like adjusted, just reply to this email or call me on 01747 637070."],
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
        "Accepting takes about half a minute, and your {{{DEPOSIT_AMOUNT}}} deposit secures both your date and crew:",
      ],
      cta: "Accept your quote online&nbsp;&rarr;",
      closing: ["If anything in the quote doesn't look right, let me know and I'll sort it before anything is booked."],
    }),
    variables: CHASE_VARS,
  },
  {
    name: "chase-quote-3",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_3",
    subject: "Your quote is valid until {{{EXPIRY_DATE}}}",
    from: CHASE_FROM,
    html: chaseHtml("Your quote is valid until {{{EXPIRY_DATE}}}.", {
      intro: [
        "A final note from me. Your quote ({{{QUOTE_REF}}}) remains valid until {{{EXPIRY_DATE}}}; after that I'd need to re-check the price.",
        "If you'd like your date held, it's one click away:",
      ],
      cta: "Accept your quote online&nbsp;&rarr;",
      closing: [
        "If you've decided to go elsewhere, that's no problem at all, and if you have a moment, any feedback on your decision would genuinely help us improve.",
        "Either way, I wish you all the best with your move.",
      ],
    }),
    variables: CHASE_VARS,
  },
  {
    name: "chase-deposit-1",
    envVar: "RESEND_TEMPLATE_CHASE_DEPOSIT_1",
    subject: "One last step to secure your move date ({{{QUOTE_REF}}})",
    from: CHASE_FROM,
    html: chaseHtml("One last step to secure your date.", {
      intro: [
        "It's {{{OWNER_NAME}}} here. Great to have you booked in. Your date is reserved, and your {{{DEPOSIT_AMOUNT}}} deposit is what makes it firm and secures your crew.",
        "You can pay by card or bank transfer on your quote page (bank transfer reference: {{{QUOTE_REF}}}):",
      ],
      cta: "Pay your deposit&nbsp;&rarr;",
      closing: ["Any questions, just reply to this email or call me on 01747 637070."],
    }),
    variables: CHASE_VARS,
  },
  {
    name: "chase-deposit-2",
    envVar: "RESEND_TEMPLATE_CHASE_DEPOSIT_2",
    subject: "Your move date is still provisional ({{{QUOTE_REF}}})",
    from: CHASE_FROM,
    html: chaseHtml("Your move date is still provisional.", {
      intro: [
        "A quick note. We're holding your move date, but I can't guarantee it much longer without your {{{DEPOSIT_AMOUNT}}} deposit, which secures both the date and crew:",
      ],
      cta: "Pay your deposit&nbsp;&rarr;",
      closing: ["If your timing has changed or plans have shifted, just reply and let me know. I'd genuinely rather help than chase."],
    }),
    variables: CHASE_VARS,
  },
];

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
  };
  await mkdir(directory, { recursive: true });
  for (const template of TEMPLATES) {
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

const existing = (await api("GET", "/templates").catch(() => ({ data: [] }))).data ?? [];
const byName = new Map(existing.map((t) => [t.name, t]));

// Resend enforces declared-variables ≡ html-variables at every moment, so an
// in-place PATCH that changes the variable SET is rejected. So: try PATCH first
// (keeps the id — no env re-wire for copy/design-only edits); only if that fails
// (a variable was added/removed) delete + recreate (new id). The loop prints an
// env line for each — apply any that changed to the app env.
const envLines = [];
for (const t of TEMPLATES) {
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
  envLines.push(`${envVar}=${id}`);
}
console.log("\n--- env (set these on the app) ---");
for (const line of envLines) console.log(line);
console.log("done");
