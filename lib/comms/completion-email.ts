/**
 * Completion certificate email — sent from the doorstep sign-off with the
 * certificate PDF attached. Prefers the published Resend template
 * (RESEND_TEMPLATE_COMPLETION_CERT — copy editable in the dashboard); this
 * in-repo HTML is the automatic fallback. Keep both in sync
 * (scripts/create-resend-templates.mjs "completion-certificate").
 */

const LOGO_URL = "https://quotes.marleymoves.co.uk/logo.png";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface CompletionEmailInput {
  firstName: string;
  moveDateLabel: string; // "Friday, 10 July 2026"
  hasExceptions: boolean;
  exceptions: string;
  customerAbsent: boolean;
}

export function completionEmailSubject(_i: CompletionEmailInput): string {
  return `Your move is complete. Certificate attached`;
}

export function completionEmailText(i: CompletionEmailInput): string {
  const lines = [
    `Hi ${i.firstName},`,
    ``,
    `That's your move done. Thank you for choosing Marley Moves. Your completion certificate is attached for your records.`,
    i.customerAbsent
      ? `Nobody was available to sign at the destination, so please check your delivered items and reply to this email within 48 hours if anything is missing or damaged.`
      : i.hasExceptions
        ? `The exceptions noted at sign-off are recorded on the certificate: ${i.exceptions}`
        : `Everything was signed off with nothing to report.`,
    ``,
    `If anything comes up, reply to this email or call Connor on 01747 637070.`,
    ``,
    `Marley Moves · 01747 637070 · hello@marleymoves.co.uk`,
  ];
  return lines.join("\n");
}

/** Variables for the published Resend template. */
export function completionEmailVariables(i: CompletionEmailInput): Record<string, string> {
  return {
    CUSTOMER_FIRST_NAME: i.firstName,
    MOVE_DATE_LABEL: i.moveDateLabel,
    STATUS_LINE: i.customerAbsent
      ? "Nobody was available to sign at the destination, so please check your delivered items and reply to this email within 48 hours if anything is missing or damaged."
      : i.hasExceptions
        ? `The exceptions noted at sign-off are recorded on your certificate: ${i.exceptions}`
        : "Everything was signed off on the day with nothing to report.",
  };
}

export function buildCompletionEmailHtml(i: CompletionEmailInput): string {
  const statusLine = completionEmailVariables(i).STATUS_LINE;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Move complete | Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your move with Marley Moves is complete. Your certificate is attached.</div>
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
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">That's you moved, ${esc(i.firstName)}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 18px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">Your move on ${esc(i.moveDateLabel)} is complete. Thank you for choosing Marley Moves. Your <strong>completion certificate is attached</strong> for your records.</p>
  </td></tr>
  <tr><td style="padding:0 36px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F4;border-radius:8px;">
      <tr><td style="padding:16px 22px;border-left:4px solid #C03838;">
        <p style="margin:0;font-size:13px;color:#5A554F;line-height:1.6;">${esc(statusLine)}</p>
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
}
