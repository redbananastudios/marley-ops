/**
 * Create/update + publish the panel's Resend email templates so their design is
 * manageable in the Resend dashboard (no deploy needed for copy/layout tweaks).
 *
 * NEEDS A FULL-ACCESS RESEND KEY for the Marley team — the everyday
 * MARLEY_RESEND_API_KEY is send-only and gets `restricted_api_key` on /templates.
 *
 * Usage:
 *   RESEND_FULL_API_KEY=re_... node scripts/create-resend-templates.mjs
 *   node scripts/create-resend-templates.mjs --preview-dir <directory>
 *
 * Idempotent: matches templates by name; existing ones are updated (PATCH) and
 * republished. Prints each template's id + the Vercel env var to set.
 *
 * After running: set the printed env vars on the Vercel project + redeploy —
 * the panel then sends via `template: { id, variables }` (see lib/comms/send.ts);
 * without the env var it falls back to the in-repo HTML.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const previewArg = process.argv.indexOf("--preview-dir");
const PREVIEW_DIR = previewArg >= 0 ? process.argv[previewArg + 1] : null;

const KEY = process.env.RESEND_FULL_API_KEY || process.env.MARLEY_RESEND_FULL_API_KEY;
if (!KEY && !PREVIEW_DIR) {
  console.error("Set RESEND_FULL_API_KEY (a FULL-ACCESS key from the Marley Resend team).");
  process.exit(1);
}

const API = "https://api.resend.com";
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

/* ---------------------------------------------------------------- templates */

const LOGO_URL = "https://quotes.marleymoves.co.uk/logo.png";

const fact = (label, value) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:38%;">${label}</td>
        <td style="padding:10px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;">${value}</td>
      </tr>`;

const surveyConfirmationHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Survey booked — Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your free home survey with Marley Moves is booked for {{{DATE_LABEL}}} at {{{TIME_LABEL}}}.</div>

<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">

  <tr><td align="center" style="padding:34px 36px 8px;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">
  </td></tr>

  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:#1A1A1A;border:1px solid #1A1A1A;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#FFFFFF;">Survey booked</div>
  </td></tr>

  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">You're in the diary, {{{CUSTOMER_FIRST_NAME}}}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 22px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">We'll come and take a proper look at your move so your fixed quote covers everything. The visit takes about an hour and there is nothing to prepare.</p>
  </td></tr>

  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${fact("When", "{{{DATE_LABEL}}} at {{{TIME_LABEL}}}")}
          ${fact("Who's coming", "{{{ESTIMATOR}}}")}
          ${fact("Where", "{{{ADDRESS}}}")}
          <tr>
            <td style="padding:10px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">How long</td>
            <td style="padding:10px 0;font-size:14px;color:#1A1A1A;font-weight:600;">About 1 hour</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 36px 26px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0;">Need to change the time? Just call us on <strong style="color:#C03838;">01747 637070</strong> or reply to this email and we'll sort it.</p>
  </td></tr>

  <tr><td style="padding:20px 36px;background:#1A1A1A;">
    <p style="margin:0;font-size:12px;color:#B8B3AC;line-height:1.7;">Marley Moves · Company No. 15914266 · 01747 637070<br>
    <a href="mailto:hello@marleymoves.co.uk" style="color:#E85959;text-decoration:none;">hello@marleymoves.co.uk</a> · <a href="https://marleymoves.co.uk" style="color:#E85959;text-decoration:none;">marleymoves.co.uk</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

/* ------------------------------------------- completion certificate (branded)
   Doorstep sign-off email — the certificate PDF rides as an attachment.
   Mirrors lib/comms/completion-email.ts buildCompletionEmailHtml (the in-repo
   fallback); keep both in sync. */

const completionCertificateHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Move complete — Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your move with Marley Moves is complete — your certificate is attached.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 8px;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">
  </td></tr>
  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:#1A1A1A;border:1px solid #1A1A1A;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#FFFFFF;">Move complete</div>
  </td></tr>
  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">That's you moved, {{{CUSTOMER_FIRST_NAME}}}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 18px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">Your move on {{{MOVE_DATE_LABEL}}} is complete — thank you for choosing Marley Moves. Your <strong>completion certificate is attached</strong> for your records.</p>
  </td></tr>
  <tr><td style="padding:0 36px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F4;border-radius:8px;">
      <tr><td style="padding:16px 22px;border-left:4px solid #C03838;">
        <p style="margin:0;font-size:13px;color:#5A554F;line-height:1.6;">{{{STATUS_LINE}}}</p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 36px 28px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0;">If anything comes up, just reply to this email or call Connor on <strong style="color:#C03838;">01747 637070</strong>.</p>
  </td></tr>
  <tr><td style="padding:20px 36px;background:#1A1A1A;">
    <p style="margin:0;font-size:12px;color:#B8B3AC;line-height:1.7;">Marley Moves · Company No. 15914266 · 01747 637070<br>
    <a href="mailto:hello@marleymoves.co.uk" style="color:#E85959;text-decoration:none;">hello@marleymoves.co.uk</a> · <a href="https://marleymoves.co.uk" style="color:#E85959;text-decoration:none;">marleymoves.co.uk</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

/* ------------------------------------------------- review request (branded)
   Post-move "how did we do?" — mirrors lib/comms/payment-email.ts
   buildReviewRequestEmailHtml (the in-repo fallback); keep both in sync. */

const reviewRequestHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Thanks for moving with Marley Moves. A quick review helps us a lot.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 8px;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">
  </td></tr>
  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:#1A1A1A;border:1px solid #1A1A1A;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#FFFFFF;">Move complete</div>
  </td></tr>
  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">How did we do, {{{CUSTOMER_FIRST_NAME}}}?</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 22px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">That's your move done — thank you for choosing Marley Moves. If Connor and the crew looked after you, a quick Google review makes a real difference to a small local firm like ours. It takes about a minute.</p>
  </td></tr>
  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="{{{REVIEW_URL}}}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">Leave a Google review &rarr;</a>
    </td></tr></table>
  </td></tr>
  <tr><td align="center" style="padding:0 36px 26px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">And if anything wasn't right, please reply to this email or call Connor on <strong style="color:#C03838;">01747 637070</strong> first — we would always rather fix it.</p>
  </td></tr>
  <tr><td style="background:#FAFAFA;border-top:1px solid #EAE7E2;padding:20px 36px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:11px;color:#6E6A65;line-height:1.7;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:600;color:#1A1A1A;">Marley <span style="color:#C03838;">Moves</span></div>
        <div style="margin-top:2px;">Shaftesbury, SP7 · Company No. 15914266</div>
      </td>
      <td align="right" style="font-size:11px;color:#6E6A65;line-height:1.7;">
        <div><a href="tel:01747637070" style="color:#1A1A1A;text-decoration:none;font-weight:600;">01747 637070</a></div>
        <div><a href="https://marleymoves.co.uk" style="color:#6E6A65;text-decoration:none;">marleymoves.co.uk</a></div>
      </td>
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

/* ------------------------------------------------- branded shell + slots
   Shared markup for the transactional emails below — mirrors the in-repo
   fallback builders in lib/comms/payment-email.ts + quote-email.ts; keep in
   sync. {{{VARS}}} are filled at send time (fragments like MOVE_DATE_CLAUSE /
   INVOICE_BUTTON arrive as pre-composed HTML from the app). */

const shellHtml = (preheader, inner) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">${preheader}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 8px;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">
  </td></tr>
${inner}
  <tr><td style="background:#FAFAFA;border-top:1px solid #EAE7E2;padding:20px 36px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:11px;color:#6E6A65;line-height:1.7;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:600;color:#1A1A1A;">Marley <span style="color:#C03838;">Moves</span></div>
        <div style="margin-top:2px;">Shaftesbury, SP7 · Company No. 15914266</div>
      </td>
      <td align="right" style="font-size:11px;color:#6E6A65;line-height:1.7;">
        <div><a href="tel:01747637070" style="color:#1A1A1A;text-decoration:none;font-weight:600;">01747 637070</a></div>
        <div><a href="https://marleymoves.co.uk" style="color:#6E6A65;text-decoration:none;">marleymoves.co.uk</a></div>
      </td>
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

const pillRow = (label) => `  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:#1A1A1A;border:1px solid #1A1A1A;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#FFFFFF;">${label}</div>
  </td></tr>`;
const headlineRow = (text) => `  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">${text}</h1>
  </td></tr>`;
const sublineRow = (html, pad = "14px 36px 22px") => `  <tr><td align="center" style="padding:${pad};">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">${html}</p>
  </td></tr>`;
const amountCard = (label, amount, note) => `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">${label}</div>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${amount}</div>${
          note ? `\n        <div style="font-size:11px;color:#6E6A65;margin-top:6px;">${note}</div>` : ""
        }
      </td></tr>
    </table>
  </td></tr>`;
const bankCardRow = (reference) => {
  const row = (l, v) => `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:42%;">${l}</td>
    <td style="padding:8px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;">${v}</td>
  </tr>`;
  return `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:10px;">Pay by bank transfer</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row("Account name", "MARLEYMOVES LTD")}
          ${row("Sort code", "04-00-03")}
          ${row("Account number", "12787423")}
          <tr>
            <td style="padding:8px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Reference</td>
            <td style="padding:8px 0;font-size:14px;color:#C03838;font-weight:700;">${reference}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;
};

/* ------------------------------------------------- payment emails */

const depositReceivedHtml = shellHtml(
  "Your {{{AMOUNT}}} deposit is received. Your move date is secured.",
  [
    pillRow("Deposit received · {{{QUOTE_REF}}}"),
    headlineRow("You're booked in, {{{CUSTOMER_FIRST_NAME}}}"),
    sublineRow(
      'We have received your {{{AMOUNT}}} deposit for your move on <strong style="color:#1A1A1A;">{{{MOVE_DATE_LABEL}}}</strong>. Your date and team are now secured.',
    ),
    amountCard("Deposit paid", "{{{AMOUNT}}}"),
    sublineRow(
      '{{{BALANCE_LINE}}} Any questions in the meantime, call Connor on <strong style="color:#C03838;">01747 637070</strong> or just reply to this email.',
      "0 36px 26px",
    ),
  ].join("\n"),
);

const balanceInvoiceHtml = shellHtml(
  "Your final balance of {{{AMOUNT}}} is due before move day.",
  [
    pillRow("Final balance · {{{QUOTE_REF}}}"),
    headlineRow("Your final balance, {{{CUSTOMER_FIRST_NAME}}}"),
    sublineRow(
      "Ahead of your move{{{MOVE_DATE_CLAUSE}}}, here is the final balance. Payment in full is due before move day so everything is settled and the crew can focus on the job.",
    ),
    amountCard(
      "Balance due{{{INVOICE_META}}}",
      "{{{AMOUNT}}}",
      "Your {{{QUOTE_REF}}} deposit is already accounted for.",
    ),
    "{{{INVOICE_BUTTON}}}",
    bankCardRow("{{{QUOTE_REF}}}"),
    sublineRow(
      'Already paid or need a different arrangement? Call Connor on <strong style="color:#C03838;">01747 637070</strong> or reply to this email.',
      "0 36px 26px",
    ),
  ].join("\n"),
);

const balanceReceivedHtml = shellHtml(
  "Balance of {{{AMOUNT}}} received. You're all set for move day.",
  [
    pillRow("Payment received · {{{QUOTE_REF}}}"),
    headlineRow("All settled, {{{CUSTOMER_FIRST_NAME}}}"),
    sublineRow(
      'We have received your balance of <strong style="color:#1A1A1A;">{{{AMOUNT}}}</strong>, so there is nothing more to pay. We will see you on <strong style="color:#1A1A1A;">{{{MOVE_DAY_LABEL}}}</strong>. Any last-minute questions, call Connor on <strong style="color:#C03838;">01747 637070</strong>.',
      "14px 36px 26px",
    ),
  ].join("\n"),
);

/* ------------------------------------------------- quote email (accept variant)
   Sent with the quote PDF attached. Mirrors lib/comms/quote-email.ts; the app
   only uses this template when the quote has an accept link (it always does
   since unified acceptance) — otherwise it falls back to the in-repo HTML. */

const quoteEmailHtml = shellHtml(
  "Your removal quote from Marley Moves: {{{GRAND_TOTAL}}}. PDF attached.",
  [
    pillRow("Ref {{{QUOTE_REF}}}"),
    headlineRow("Your move is quoted, {{{CUSTOMER_FIRST_NAME}}}"),
    sublineRow(
      'Here is the full price for your move{{{MOVE_DATE_CLAUSE}}}. Accept online in 30 seconds to lock it in, or call Connor on <strong style="color:#C03838;">01747 637070</strong> if anything needs changing.',
    ),
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="padding:22px 26px;border-left:4px solid #C03838;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Total Move Cost</div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:42px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">{{{GRAND_TOTAL}}}</div>
          <div style="font-size:11px;color:#6E6A65;margin-top:6px;">{{{TOTAL_COST_NOTE}}}</div>
        </td>
        <td align="right" valign="middle" style="padding:22px 26px;border-left:1px solid #EAE7E2;width:150px;">
          <div style="font-size:10px;color:#6E6A65;text-transform:uppercase;letter-spacing:0.18em;">Expires</div>
          <div style="font-size:14px;color:#1A1A1A;font-weight:700;margin-top:4px;">{{{EXPIRY_DATE}}}</div>
        </td>
      </tr>
    </table>
  </td></tr>`,
    `  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:10px;">Job at a glance</div>
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top" style="width:46%;">
            <div style="font-size:10px;color:#6E6A65;letter-spacing:0.1em;text-transform:uppercase;">Collection</div>
            <div style="font-size:13px;color:#1A1A1A;font-weight:600;margin-top:4px;line-height:1.45;">{{{COLLECTION_HTML}}}</div>
          </td>
          <td align="center" valign="middle" style="width:8%;font-size:18px;color:#C03838;font-weight:600;">&rarr;</td>
          <td valign="top" style="width:46%;">
            <div style="font-size:10px;color:#6E6A65;letter-spacing:0.1em;text-transform:uppercase;">Destination</div>
            <div style="font-size:13px;color:#1A1A1A;font-weight:600;margin-top:4px;line-height:1.45;">{{{DESTINATION_HTML}}}</div>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid #EAE7E2;padding-top:14px;"><tr>
          <td style="width:34%;font-size:11px;color:#6E6A65;vertical-align:top;">
            <div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Date</div>
            <div style="color:#1A1A1A;font-weight:600;margin-top:2px;">{{{MOVE_DATE_GLANCE}}}</div>
          </td>
          <td style="width:33%;font-size:11px;color:#6E6A65;vertical-align:top;">
            <div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Vehicle</div>
            <div style="color:#1A1A1A;font-weight:600;margin-top:2px;">{{{VEHICLE}}}</div>
          </td>
          <td style="width:33%;font-size:11px;color:#6E6A65;vertical-align:top;">
            <div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Packing</div>
            <div style="color:#1A1A1A;font-weight:600;margin-top:2px;">{{{PACKING}}}</div>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>`,
    `  <tr><td align="center" style="padding:0 36px 10px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="{{{ACCEPT_URL}}}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">Accept your quote online &rarr;</a>
    </td></tr></table>
  </td></tr>
  <tr><td align="center" style="padding:0 36px 22px;">
    <p style="font-size:11px;color:#9CA3AF;margin:0;">Prefer email? <a href="{{{REPLY_HREF}}}" style="color:#6E6A65;">Reply to confirm</a> instead.</p>
  </td></tr>`,
    `  <tr><td style="padding:8px 36px 28px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:14px;">What happens next</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:33%;vertical-align:top;padding-right:10px;">
        <div style="width:30px;height:30px;background:#1A1A1A;color:#FFFFFF;text-align:center;line-height:30px;font-size:13px;font-weight:700;font-family:Georgia,'Times New Roman',serif;border-radius:50%;">1</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A;margin-top:8px;">Accept your quote</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:3px;line-height:1.5;">Tap the button above (takes about 30 seconds) and your date is reserved.</div>
      </td>
      <td style="width:34%;vertical-align:top;padding-right:10px;">
        <div style="width:30px;height:30px;background:#1A1A1A;color:#FFFFFF;text-align:center;line-height:30px;font-size:13px;font-weight:700;font-family:Georgia,'Times New Roman',serif;border-radius:50%;">2</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A;margin-top:8px;">{{{DEPOSIT_AMOUNT}}} deposit</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:3px;line-height:1.5;">Pay by card or bank transfer straight after accepting. This locks the booking in.</div>
      </td>
      <td style="width:33%;vertical-align:top;">
        <div style="width:30px;height:30px;background:#1A1A1A;color:#FFFFFF;text-align:center;line-height:30px;font-size:13px;font-weight:700;font-family:Georgia,'Times New Roman',serif;border-radius:50%;">3</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A;margin-top:8px;">Move day</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:3px;line-height:1.5;">We arrive on time. Balance due on completion.</div>
      </td>
    </tr></table>
  </td></tr>`,
    `  <tr><td style="padding:0 36px 20px;">
    <div style="font-size:10px;color:#9CA3AF;line-height:1.5;">Issued {{{ISSUED_DATE}}} · valid 30 days · ref {{{QUOTE_REF}}}. Prices are subject to a site survey where applicable.</div>
  </td></tr>`,
  ].join("\n"),
);

/* ------------------------------------------------- chase emails (personal look)
   Personal voice from Peter — canonical copy lives in lib/quote/chase.ts;
   keep both in sync. The signature mirrors Peter's Outlook signature.
   NO template-level reply_to: the chase engine sets the per-lead
   q-<token>@reply.marleymoves.co.uk address on each send. */

const peterSignatureHtml = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="360" style="width:100%;max-width:360px;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;color:#1F1D1B;mso-line-height-rule:exactly;">
  <tr><td style="padding:0 0 3px;font-size:20px;line-height:24px;font-weight:700;color:#111111;">Peter Farrell</td></tr>
  <tr><td style="padding:0 0 12px;font-size:13px;line-height:18px;color:#3A3A3A;">Director <span style="color:#C03838;">|</span> Marley Moves</td></tr>
  <tr><td style="padding:0 0 12px;border-top:2px solid #C03838;font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 9px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/phone.png" width="18" height="18" alt="Telephone" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="tel:01747637070" style="color:#1F1D1B;text-decoration:none;">01747 637070</a><span style="color:#C03838;"> | </span><a href="tel:07572382366" style="color:#1F1D1B;text-decoration:none;">07572 382 366</a></td>
      </tr>
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 9px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/new-post.png" width="18" height="18" alt="Email" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="mailto:peter@marleymoves.co.uk" style="color:#1F1D1B;text-decoration:none;">peter@marleymoves.co.uk</a></td>
      </tr>
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 9px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/globe--v1.png" width="18" height="18" alt="Website" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 9px;font-size:12px;line-height:18px;color:#1F1D1B;"><a href="https://www.marleymoves.co.uk" style="color:#1F1D1B;text-decoration:none;">www.marleymoves.co.uk</a></td>
      </tr>
      <tr>
        <td width="24" valign="top" style="width:24px;padding:0 6px 10px 0;"><img src="https://img.icons8.com/ios-filled/50/c03838/marker.png" width="18" height="18" alt="Address" border="0" style="display:block;width:18px;height:18px;border:0;"></td>
        <td valign="top" style="padding:0 0 10px;font-size:12px;line-height:18px;color:#1F1D1B;">Ash Cottage, Sherborne Causeway,<br>Shaftesbury, SP7 9PX</td>
      </tr>
      <tr>
        <td width="24" style="width:24px;padding:0 6px 0 0;font-size:0;line-height:0;">&nbsp;</td>
        <td style="padding:0 0 12px;border-bottom:1px solid #D9D9D9;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>
            <td style="padding:0 8px 0 0;"><a href="https://www.facebook.com/marleymoves" style="display:block;text-decoration:none;"><img src="https://img.icons8.com/ios-filled/50/c03838/facebook-new.png" width="24" height="24" alt="Facebook" border="0" style="display:block;width:24px;height:24px;border:0;"></a></td>
            <td style="padding:0 8px 0 0;"><a href="https://www.instagram.com/marleymovesltd" style="display:block;text-decoration:none;"><img src="https://img.icons8.com/ios-filled/50/c03838/instagram-new.png" width="24" height="24" alt="Instagram" border="0" style="display:block;width:24px;height:24px;border:0;"></a></td>
            <td style="padding:0;"><a href="https://wa.me/441747637070" style="display:block;text-decoration:none;"><img src="https://img.icons8.com/ios-filled/50/c03838/whatsapp.png" width="24" height="24" alt="WhatsApp" border="0" style="display:block;width:24px;height:24px;border:0;"></a></td>
          </tr></table>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:12px 0 0;"><a href="https://www.marleymoves.co.uk" style="text-decoration:none;border:0;"><img src="https://marleymoves.co.uk/logo.png" width="235" alt="Marley Moves" border="0" style="display:block;width:235px;max-width:100%;height:auto;border:0;"></a></td></tr>
  <tr><td style="padding:12px 0 0;font-size:9px;line-height:13px;color:#6A6A6A;">This communication contains information which is confidential and may also be privileged. It is for the exclusive use of the intended recipient. If you are not the intended recipient, please note that any form of distribution, copying or use of this communication or the information contained therein is strictly prohibited and may be unlawful.</td></tr>
</table>`;

const plain = (text) => {
  const body = text.replace(/\nPeter\s*$/, "").trim();
  const linked = body.replace(
    /\{\{\{ACCEPT_LINK\}\}\}/g,
    '<a href="{{{ACCEPT_LINK}}}" style="color:#C03838;text-decoration:underline;">{{{ACCEPT_LINK}}}</a>',
  );
  const paragraphs = linked
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;">${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#FFFFFF;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;"><tr><td style="padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1A1A1A;line-height:1.7;">${paragraphs}</td></tr><tr><td style="padding:8px 0 0;">${peterSignatureHtml}</td></tr></table></td></tr></table></body></html>`;
};

const CHASE_FROM = "Peter Farrell at Marley Moves <peter@marleymoves.co.uk>";
const CHASE_VARS = [
  { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
  { key: "QUOTE_REF", type: "string", fallback_value: "your quote" },
  { key: "ACCEPT_LINK", type: "string", fallback_value: "https://marleymoves.co.uk/quote/" },
  { key: "EXPIRY_DATE", type: "string", fallback_value: "the expiry date on your quote" },
];

/** The registry: add future templates here and re-run. envVar is what the panel reads. */
const TEMPLATES = [
  {
    name: "survey-confirmation",
    envVar: "RESEND_TEMPLATE_SURVEY_CONFIRMATION",
    subject: "Your survey is booked — {{{DATE_LABEL}}}, {{{TIME_LABEL}}}",
    from: "Marley Moves <quotes@marleymoves.co.uk>",
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
    from: "Marley Moves <quotes@marleymoves.co.uk>",
    html: quoteEmailHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      { key: "QUOTE_REF", type: "string", fallback_value: "your quote" },
      { key: "GRAND_TOTAL", type: "string", fallback_value: "the quoted total" },
      { key: "TOTAL_COST_NOTE", type: "string", fallback_value: "Includes admin fee" },
      { key: "EXPIRY_DATE", type: "string", fallback_value: "30 days from issue" },
      { key: "MOVE_DATE_CLAUSE", type: "string", fallback_value: "" },
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
    from: "Marley Moves <quotes@marleymoves.co.uk>",
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
          "We will send your final invoice nearer the time. The balance is due before move day.",
      },
    ],
  },
  {
    name: "balance-invoice",
    envVar: "RESEND_TEMPLATE_BALANCE_INVOICE",
    subject: "Your final balance — {{{QUOTE_REF}}} ({{{AMOUNT}}})",
    from: "Marley Moves <quotes@marleymoves.co.uk>",
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
    from: "Marley Moves <quotes@marleymoves.co.uk>",
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
    from: "Marley Moves <quotes@marleymoves.co.uk>",
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
    from: "Connor at Marley Moves <quotes@marleymoves.co.uk>",
    // NO template-level reply_to: the sender sets the per-lead reply address.
    html: reviewRequestHtml,
    variables: [
      { key: "CUSTOMER_FIRST_NAME", type: "string", fallback_value: "there" },
      {
        key: "REVIEW_URL",
        type: "string",
        fallback_value:
          "https://search.google.com/local/writereview?placeid=ChIJq8R84fCs_EkRc_9iHhFQXW8",
      },
    ],
  },
  {
    name: "chase-quote-1",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_1",
    subject: "Did my quote come through okay, {{{CUSTOMER_FIRST_NAME}}}?",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

Peter here from Marley Moves. I wanted to make sure quote {{{QUOTE_REF}}} reached you and see if anything needs explaining or changing.

If you're happy with everything, you can accept it online here:
{{{ACCEPT_LINK}}}

It takes about 30 seconds and provisionally reserves your move date.

If you'd rather talk it through, reply to this email or call me on 01747 637070.

Thanks,
Peter`),
    variables: CHASE_VARS,
  },
  {
    name: "chase-quote-2",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_2",
    subject: "Would you like me to hold your move date?",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

I'm checking in on quote {{{QUOTE_REF}}}. Dates are starting to fill for the coming weeks, with Fridays and month-end usually going first.

If you'd like to go ahead, accept online and pay the £100 deposit to confirm the crew and date:
{{{ACCEPT_LINK}}}

If you're still deciding, or anything in the quote needs changing, just reply and I'll help.

Thanks,
Peter`),
    variables: CHASE_VARS,
  },
  {
    name: "chase-quote-3",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_3",
    subject: "Your quote is valid until {{{EXPIRY_DATE}}}",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

This is my last follow-up about quote {{{QUOTE_REF}}}. It stays valid until {{{EXPIRY_DATE}}}; after that I'll need to re-check both the price and availability.

If you'd like to go ahead, you can accept it here:
{{{ACCEPT_LINK}}}

If you no longer need the quote, reply with "not going ahead" and I won't follow up again. If you've chosen someone else, a one-line note about what made the difference would genuinely help us improve.

All the best with the move either way,
Peter`),
    variables: CHASE_VARS,
  },
  {
    name: "chase-deposit-1",
    envVar: "RESEND_TEMPLATE_CHASE_DEPOSIT_1",
    subject: "One last step to secure your move date ({{{QUOTE_REF}}})",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

Thanks for accepting your quote. I've provisionally held your move date; the £100 deposit confirms the booking and allocates the crew.

You can pay by card or bank transfer from your quote page:
{{{ACCEPT_LINK}}}

Bank transfer reference: {{{QUOTE_REF}}}

Once payment arrives, we'll email confirmation that everything is booked in.

Thanks,
Peter`),
    variables: CHASE_VARS,
  },
  {
    name: "chase-deposit-2",
    envVar: "RESEND_TEMPLATE_CHASE_DEPOSIT_2",
    subject: "Your move date is still provisional ({{{QUOTE_REF}}})",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

I'm still holding your move date provisionally. To confirm it, please pay the £100 deposit using your quote page:
{{{ACCEPT_LINK}}}

If your plans have changed or you need help with payment, reply and let me know. I'd rather help than keep chasing.

Thanks,
Peter`),
    variables: CHASE_VARS,
  },
];

if (PREVIEW_DIR) {
  const directory = resolve(PREVIEW_DIR);
  const previewValues = {
    CUSTOMER_FIRST_NAME: "Alex",
    QUOTE_REF: "MM-2048",
    ACCEPT_LINK: "https://ops.marleymoves.co.uk/q/example",
    ACCEPT_URL: "https://ops.marleymoves.co.uk/q/example",
    EXPIRY_DATE: "12 August",
    AMOUNT: "£1,245.00",
    GRAND_TOTAL: "£1,845.00",
    MOVE_DATE_LABEL: "Friday 24 July",
    MOVE_DAY_LABEL: "Friday 24 July",
    MOVE_DATE_CLAUSE: " on Friday 24 July",
    MOVE_DATE_GLANCE: "24 July 2026",
    COLLECTION_HTML: "12 High Street<br>Shaftesbury, SP7",
    DESTINATION_HTML: "8 Station Road<br>Salisbury, SP2",
    VEHICLE: "Large removal van",
    PACKING: "Customer packed",
    REPLY_HREF: "mailto:peter@marleymoves.co.uk",
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

/* ---------------------------------------------------------------- api helpers */

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.message || JSON.stringify(json)}`);
  return json;
}

const existing = (await api("GET", "/templates").catch(() => ({ data: [] }))).data ?? [];
const byName = new Map(existing.map((t) => [t.name, t]));

for (const t of TEMPLATES) {
  const { envVar, ...def } = t;
  let id = byName.get(t.name)?.id;
  if (id) {
    await api("PATCH", `/templates/${id}`, def);
    console.log(`updated  ${t.name} (${id})`);
  } else {
    id = (await api("POST", "/templates", def)).id;
    console.log(`created  ${t.name} (${id})`);
  }
  // Publish the draft so sends can use it.
  await api("POST", `/templates/${id}/publish`).catch(async (e) => {
    console.warn(`  publish endpoint failed (${e.message}) — publish "${t.name}" in the Resend dashboard.`);
  });
  console.log(`  -> set on Vercel: ${envVar}=${id}`);
}
console.log("done");
