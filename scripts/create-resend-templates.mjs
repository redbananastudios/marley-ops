/**
 * Create/update + publish the panel's Resend email templates so their design is
 * manageable in the Resend dashboard (no deploy needed for copy/layout tweaks).
 *
 * NEEDS A FULL-ACCESS RESEND KEY for the Marley team — the everyday
 * MARLEY_RESEND_API_KEY is send-only and gets `restricted_api_key` on /templates.
 *
 * Usage:
 *   RESEND_FULL_API_KEY=re_... node scripts/create-resend-templates.mjs
 *
 * Idempotent: matches templates by name; existing ones are updated (PATCH) and
 * republished. Prints each template's id + the Vercel env var to set.
 *
 * After running: set the printed env vars on the Vercel project + redeploy —
 * the panel then sends via `template: { id, variables }` (see lib/comms/send.ts);
 * without the env var it falls back to the in-repo HTML.
 */

const KEY = process.env.RESEND_FULL_API_KEY || process.env.MARLEY_RESEND_FULL_API_KEY;
if (!KEY) {
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
    <div style="display:inline-block;padding:6px 14px;background:#FFF3F1;border:1px solid #F5C9C4;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#C03838;">Survey booked</div>
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
    <div style="display:inline-block;padding:6px 14px;background:#FFF3F1;border:1px solid #F5C9C4;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#C03838;">Move complete</div>
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

/* ------------------------------------------------- chase emails (plain look)
   Personal plain-text voice from Connor — canonical copy lives in
   lib/quote/chase.ts (approved by Peter 2026-07-09); keep both in sync.
   NO template-level reply_to: the chase engine sets the per-lead
   q-<token>@reply.marleymoves.co.uk address on each send. */

const plain = (text) =>
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.7;white-space:pre-wrap;">${text.replace(
    /\{\{\{ACCEPT_LINK\}\}\}/g,
    '<a href="{{{ACCEPT_LINK}}}" style="color:#1a56db;">{{{ACCEPT_LINK}}}</a>',
  )}</div>`;

const CHASE_FROM = "Connor at Marley Moves <quotes@marleymoves.co.uk>";
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
    subject: "Did the quote come through okay, {{{CUSTOMER_FIRST_NAME}}}?",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

Connor here from Marley Moves. Just checking the quote for your move landed safely and seeing if you had any questions about it.

If you're happy with everything, you can accept it online in about 30 seconds and that reserves your date:
{{{ACCEPT_LINK}}}

Anything you'd like changing, just reply to this email or ring me on 01747 637070.

Thanks,
Connor
Marley Moves`),
    variables: CHASE_VARS,
  },
  {
    name: "chase-quote-2",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_2",
    subject: "Shall I pencil your date in?",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

Dates are starting to fill for the coming weeks (month-end and Fridays always go first), so I wanted to check where you're at with your quote.

Accepting online takes half a minute and the £100 deposit locks the crew and date in for you:
{{{ACCEPT_LINK}}}

If something in the quote doesn't look right, tell me and I'll sort it before anything is booked.

Thanks,
Connor`),
    variables: CHASE_VARS,
  },
  {
    name: "chase-quote-3",
    envVar: "RESEND_TEMPLATE_CHASE_QUOTE_3",
    subject: "Your quote is valid until {{{EXPIRY_DATE}}}",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

A last note from me. Your quote {{{QUOTE_REF}}} stays valid until {{{EXPIRY_DATE}}}, after that I'd need to re-check the price.

If you'd like the date held it's one click here:
{{{ACCEPT_LINK}}}

And if you've decided to go another way, no hard feelings at all. A one-line reply telling me what swung it would genuinely help us do better.

All the best with the move either way,
Connor
01747 637070`),
    variables: CHASE_VARS,
  },
  {
    name: "chase-deposit-1",
    envVar: "RESEND_TEMPLATE_CHASE_DEPOSIT_1",
    subject: "Locking in your move date ({{{QUOTE_REF}}})",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

Great to have you booked in. Your date is reserved, and the £100 deposit is what makes it firm on our side.

Everything you need is on your quote page, card or bank transfer:
{{{ACCEPT_LINK}}}

Bank transfer reference: {{{QUOTE_REF}}}

Thanks,
Connor`),
    variables: CHASE_VARS,
  },
  {
    name: "chase-deposit-2",
    envVar: "RESEND_TEMPLATE_CHASE_DEPOSIT_2",
    subject: "Your date is still waiting ({{{QUOTE_REF}}})",
    from: CHASE_FROM,
    html: plain(`Hi {{{CUSTOMER_FIRST_NAME}}},

Just a nudge, we're holding your move date but I can't guarantee it much longer without the £100 deposit ({{{ACCEPT_LINK}}}).

If timing is tricky or plans have shifted, reply and tell me, I'd rather help than chase.

Thanks,
Connor`),
    variables: CHASE_VARS,
  },
];

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
