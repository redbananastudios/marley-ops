/**
 * Storage invoice email — sent by the daily billing cron with Zoho's VAT PDF
 * attached. BACS-first per the card policy (deposit is the only card payment).
 * Inline-branded HTML (no published template yet — add one to
 * scripts/create-resend-templates.mjs if Connor wants dashboard editing).
 */

const LOGO_URL = "https://quotes.marleymoves.co.uk/logo.png";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface StorageInvoiceEmailInput {
  firstName: string;
  unitLabel: string; // "20ft container SC-1 at Shaftesbury Yard"
  periodLabel: string; // "14 Jul – 20 Jul 2026"
  amountLabel: string; // "£25.00"
  invoiceNumber: string;
  invoiceUrl: string | null;
  /** Kind-specific closing line (crate minimum/arrears/final differ from the
   *  in-advance container copy). Defaults to the container wording. */
  footerNote?: string;
}

const DEFAULT_FOOTER_NOTE =
  "Storage is billed in advance each period and runs until you tell us you're done — reply to this email or call 01747 637070 to arrange collection.";

export function storageInvoiceSubject(i: StorageInvoiceEmailInput): string {
  return `Your storage invoice — ${i.invoiceNumber} (${i.amountLabel})`;
}

export function storageInvoiceText(i: StorageInvoiceEmailInput): string {
  return [
    `Hi ${i.firstName},`,
    ``,
    `Your storage invoice for ${i.unitLabel} is attached.`,
    `Period: ${i.periodLabel} · Amount: ${i.amountLabel} · Invoice: ${i.invoiceNumber}`,
    ``,
    `Pay by bank transfer to MARLEYMOVES LTD, sort code 04-00-03, account 12787423, using reference ${i.invoiceNumber}.`,
    i.invoiceUrl ? `View the invoice online: ${i.invoiceUrl}` : ``,
    ``,
    i.footerNote ?? DEFAULT_FOOTER_NOTE,
    ``,
    `Questions? Reply to this email or call 01747 637070.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildStorageInvoiceEmailHtml(i: StorageInvoiceEmailInput): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Storage invoice — Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your storage invoice ${esc(i.invoiceNumber)} for ${esc(i.periodLabel)} — ${esc(i.amountLabel)}.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 8px;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">
  </td></tr>
  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:#FFF3F1;border:1px solid #F5C9C4;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#C03838;">Storage invoice</div>
  </td></tr>
  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">${esc(i.amountLabel)} for your storage, ${esc(i.firstName)}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 20px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">Invoice <strong>${esc(i.invoiceNumber)}</strong> covers <strong>${esc(i.unitLabel)}</strong> for <strong>${esc(i.periodLabel)}</strong>. The PDF is attached for your records.</p>
  </td></tr>
  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:18px 24px;border-left:4px solid #C03838;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Pay by bank transfer</p>
        <p style="margin:0;font-size:14px;line-height:1.8;color:#1A1A1A;"><strong>MARLEYMOVES LTD</strong> · Sort code <strong>04-00-03</strong> · Account <strong>12787423</strong><br>Reference: <strong>${esc(i.invoiceNumber)}</strong></p>
      </td></tr>
    </table>
  </td></tr>
  ${
    i.invoiceUrl
      ? `<tr><td align="center" style="padding:0 36px 26px;">
    <a href="${esc(i.invoiceUrl)}" style="display:inline-block;padding:13px 32px;background:#FFFFFF;border:1.5px solid #C03838;color:#C03838;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;">View invoice online</a>
  </td></tr>`
      : ""
  }
  <tr><td style="padding:0 36px 28px;">
    <p style="font-size:13px;color:#5A554F;line-height:1.65;margin:0;">${esc(i.footerNote ?? DEFAULT_FOOTER_NOTE)}</p>
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
