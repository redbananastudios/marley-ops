/**
 * Survey-booked confirmation — the customer's "it's in the diary" moment.
 * Sent automatically when a survey appointment is booked against a lead
 * (see createAppointment). Same house style as the quote email: logo on
 * white, Georgia headline, brand-red accents. UK English, no em-dash.
 *
 * Pure server util — no React, no DOM. Returns strings.
 */

const LOGO_URL = "https://quotes.marleymoves.co.uk/logo.png";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SurveyConfirmInput {
  customerName: string | null;
  /** "Thursday 10 July" — already UK wall-clock. */
  dateLabel: string;
  /** "14:00" — already UK wall-clock. */
  timeLabel: string;
  estimatorName: string | null;
  /** Where the visit happens (the pickup address). */
  address: string | null;
}

export function surveyConfirmSms(i: SurveyConfirmInput): string {
  const first = (i.customerName || "").trim().split(/\s+/)[0] || "there";
  const who = i.estimatorName ? `${i.estimatorName} from Marley Moves` : "One of the Marley Moves team";
  const where = i.address ? ` at ${i.address}` : "";
  return (
    `Hi ${first}, your free home survey is booked for ${i.dateLabel} at ${i.timeLabel}. ` +
    `${who} will visit you${where}. Need to change it? Call 01747 637070. Marley Moves`
  );
}

export function surveyConfirmSubject(i: SurveyConfirmInput): string {
  return `Your survey is booked — ${i.dateLabel}, ${i.timeLabel}`;
}

export function surveyConfirmEmailHtml(i: SurveyConfirmInput): string {
  const first = (i.customerName || "").trim().split(/\s+/)[0] || null;
  const headlineName = first ? `, ${escapeHtml(first)}` : "";
  const who = i.estimatorName ? escapeHtml(i.estimatorName) : "One of our team";
  const addr = i.address ? escapeHtml(i.address) : null;

  const fact = (label: string, value: string) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:38%;">${label}</td>
        <td style="padding:10px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;">${value}</td>
      </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Survey booked — Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your free home survey with Marley Moves is booked for ${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}.</div>

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
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">You're in the diary${headlineName}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 22px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">We'll come and take a proper look at your move so your fixed quote covers everything. The visit takes about an hour and there is nothing to prepare.</p>
  </td></tr>

  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid #C03838;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${fact("When", `${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}`)}
          ${fact("Who's coming", who)}
          ${addr ? fact("Where", addr) : ""}
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
}

export function surveyConfirmEmailText(i: SurveyConfirmInput): string {
  const first = (i.customerName || "").trim().split(/\s+/)[0] || "there";
  const who = i.estimatorName ? `${i.estimatorName} from Marley Moves` : "One of the Marley Moves team";
  return [
    `Hi ${first},`,
    ``,
    `Your free home survey is booked for ${i.dateLabel} at ${i.timeLabel}.`,
    `${who} will come and take a proper look at your move so your fixed quote covers everything.${i.address ? ` The visit is at ${i.address}.` : ""} It takes about an hour and there is nothing to prepare.`,
    ``,
    `Need to change the time? Call 01747 637070 or reply to this email.`,
    ``,
    `Marley Moves · 01747 637070 · hello@marleymoves.co.uk`,
  ].join("\n");
}
