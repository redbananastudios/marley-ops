/**
 * Storage invoice email — sent by the daily billing cron with Zoho's VAT PDF
 * attached. BACS-first, card by phone (Peter, 2026-07-29: card is accepted
 * now, so every invoice offers it alongside bank transfer).
 * Inline-branded HTML (no published template yet — add one to
 * scripts/create-resend-templates.mjs if Connor wants dashboard editing).
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): the input takes an optional
 * `brand`; absent/marley renders today's exact bytes via the default theme in
 * lib/comms/email-brand.ts. A non-default brand's bank block carries
 * disclosure (a) — payment goes to MarleyMoves Ltd — and mentions card only
 * when the brand's phone-card channel is live (`offerCardPhone`).
 */

import type { Brand } from "@/lib/brand";
import { BANK_DETAILS, emailTheme, themedDarkFooter, themedPill } from "@/lib/comms/email-brand";

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
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
  /** Phone-card availability for NON-default brands (global AND brand card
   *  switches, PRD §11.10). Ignored for marley — its literals stand. */
  offerCardPhone?: boolean;
}

const DEFAULT_FOOTER_NOTE =
  "Storage is billed in advance each period. Whenever you're ready to arrange collection, please get in touch and we'll book it in.";

export function storageInvoiceSubject(i: StorageInvoiceEmailInput): string {
  return `Your storage invoice: ${i.invoiceNumber} (${i.amountLabel})`;
}

export function storageInvoiceText(i: StorageInvoiceEmailInput): string {
  const t = emailTheme(i.brand, { cardPhone: i.offerCardPhone });
  const payToNote = t.payToNoteText(i.invoiceNumber);
  return [
    `Hi ${i.firstName},`,
    ``,
    `Your storage invoice for ${i.unitLabel} is attached.`,
    `Period: ${i.periodLabel} · Amount: ${i.amountLabel} · Invoice: ${i.invoiceNumber}`,
    ``,
    `Pay by bank transfer to ${BANK_DETAILS.name}, sort code ${BANK_DETAILS.sortCode}, account ${BANK_DETAILS.account}, using reference ${i.invoiceNumber}.`,
    t.cardPhone ? `Prefer to pay by card? Call ${t.phone} and we'll take it over the phone.` : ``,
    payToNote,
    i.invoiceUrl ? `View the invoice online: ${i.invoiceUrl}` : ``,
    ``,
    i.footerNote ?? DEFAULT_FOOTER_NOTE,
    ``,
    `Questions? Reply to this email or call ${t.phone}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildStorageInvoiceEmailHtml(i: StorageInvoiceEmailInput): string {
  const t = emailTheme(i.brand, { cardPhone: i.offerCardPhone });
  const payToNote = t.payToNoteHtml(i.invoiceNumber);
  const cardLine = t.cardPhone
    ? `\n        <p style="margin:8px 0 0;font-size:13px;line-height:1.65;color:#5A554F;">Prefer to pay by card? Call <strong style="color:#1A1A1A;">${esc(t.phone)}</strong> and we'll take it over the phone.</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Storage invoice | ${esc(t.name)}</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your storage invoice ${esc(i.invoiceNumber)} for ${esc(i.periodLabel)}: ${esc(i.amountLabel)}.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">
  <tr><td align="center" style="padding:34px 36px 8px;">
    ${t.logoHtml}
  </td></tr>
${themedPill("Storage invoice", t)}
  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">${esc(i.amountLabel)} for your storage, ${esc(i.firstName)}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 20px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">Invoice <strong>${esc(i.invoiceNumber)}</strong> covers <strong>${esc(i.unitLabel)}</strong> for <strong>${esc(i.periodLabel)}</strong>. The PDF is attached for your records.</p>
  </td></tr>
  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:18px 24px;border-left:4px solid ${t.accent};">
        <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">${t.cardPhone ? "Pay by bank transfer or card" : "Pay by bank transfer"}</p>
        <p style="margin:0;font-size:14px;line-height:1.8;color:#1A1A1A;"><strong>${BANK_DETAILS.name}</strong> · Sort code <strong>${BANK_DETAILS.sortCode}</strong> · Account <strong>${BANK_DETAILS.account}</strong><br>Reference: <strong>${esc(i.invoiceNumber)}</strong></p>${cardLine}${
          payToNote
            ? `\n        <p style="margin:8px 0 0;font-size:12.5px;line-height:1.6;color:#5A554F;">${payToNote}</p>`
            : ""
        }
      </td></tr>
    </table>
  </td></tr>
  ${
    i.invoiceUrl
      ? `<tr><td align="center" style="padding:0 36px 26px;">
    <a href="${esc(i.invoiceUrl)}" style="display:inline-block;padding:13px 32px;background:#FFFFFF;border:1.5px solid ${t.accent};color:${t.accent};font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;">View invoice online</a>
  </td></tr>`
      : ""
  }
  <tr><td style="padding:0 36px 28px;">
    <p style="font-size:13px;color:#5A554F;line-height:1.65;margin:0;">${esc(i.footerNote ?? DEFAULT_FOOTER_NOTE)}</p>
  </td></tr>
${themedDarkFooter(t)}
</table>
</td></tr>
</table>
</body>
</html>`;
}
