/**
 * Completion certificate email — sent from the doorstep sign-off with the
 * certificate PDF attached. Prefers the published Resend template
 * (RESEND_TEMPLATE_COMPLETION_CERT — copy editable in the dashboard); this
 * in-repo HTML is the automatic fallback. Keep both in sync
 * (scripts/create-resend-templates.mjs "completion-certificate").
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): the input takes an optional
 * `brand`; absent/marley renders today's exact bytes via the default theme in
 * lib/comms/email-brand.ts.
 */

import type { Brand } from "@/lib/brand";
import { emailTheme, themedDarkFooter, themedPill } from "@/lib/comms/email-brand";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface CompletionEmailInput {
  firstName: string;
  moveDateLabel: string; // "Friday, 10 July 2026"
  hasExceptions: boolean;
  exceptions: string;
  customerAbsent: boolean;
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

export function completionEmailSubject(_i: CompletionEmailInput): string {
  return `Your move is complete. Certificate attached`;
}

export function completionEmailText(i: CompletionEmailInput): string {
  const t = emailTheme(i.brand);
  const lines = [
    `Hi ${i.firstName},`,
    ``,
    `That's your move done. Thank you for choosing ${t.name}. Your completion certificate is attached for your records.`,
    i.customerAbsent
      ? `Nobody was available to sign at the destination, so please check your delivered items and reply to this email within 48 hours if anything is missing or damaged.`
      : i.hasExceptions
        ? `The exceptions noted at sign-off are recorded on the certificate: ${i.exceptions}`
        : `Everything was signed off with nothing to report.`,
    ``,
    `If anything comes up, reply to this email or ${t.callText}.`,
    ``,
    `${t.name} · ${t.phone} · ${t.helloAddress}`,
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
  const t = emailTheme(i.brand);
  const statusLine = completionEmailVariables(i).STATUS_LINE;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Move complete | ${esc(t.name)}</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your move with ${esc(t.name)} is complete. Your certificate is attached.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 8px;">
    ${t.logoHtml}
  </td></tr>
${themedPill("Move complete", t)}
  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">That's you moved, ${esc(i.firstName)}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 18px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">Your move on ${esc(i.moveDateLabel)} is complete. Thank you for choosing ${esc(t.name)}. Your <strong>completion certificate is attached</strong> for your records.</p>
  </td></tr>
  <tr><td style="padding:0 36px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F4;border-radius:8px;">
      <tr><td style="padding:16px 22px;border-left:4px solid ${t.accent};">
        <p style="margin:0;font-size:13px;color:#5A554F;line-height:1.6;">${esc(statusLine)}</p>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 36px 28px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0;">If anything comes up, just reply to this email or ${t.callHtml}.</p>
  </td></tr>
${themedDarkFooter(t)}
</table>
</td></tr>
</table>
</body>
</html>`;
}
