/**
 * Branded customer quote email — port of the live MM Quotes "Option B"
 * (service-forward) template from quotes-app/api/send-quote.js buildEmailHtml().
 *
 * Logo on white, "Your move is quoted, {firstName}", total card driven by
 * grandTotal, route arrow collect -> dest, "What happens next" (incl. the
 * £100 deposit step), and a reply-to-confirm CTA. UK English, no em-dash.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): the meta takes an optional
 * `brand`; absent/marley renders BYTE-IDENTICAL to today via the default
 * theme in lib/comms/email-brand.ts. A non-default brand's chrome, phone,
 * reply address and card wording come from its row.
 *
 * Pure server util — no React, no DOM. Returns an HTML string.
 */

import type { QuoteBreakdown } from "@/lib/quote/pricing";
import type { QuoteFormValues } from "@/lib/quote/form-types";
import type { Brand } from "@/lib/brand";
import { emailTheme, themedPill } from "@/lib/comms/email-brand";

const gbp = (n: number | null | undefined): string =>
  n == null || isNaN(n as number)
    ? "—"
    : "£" +
      Number(n)
        .toFixed(2)
        .replace(/\.00$/, "")
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split "Address line 1, Town, POSTCODE" into two display lines for the route card. */
function splitAddr(a: string): [string, string] {
  if (!a) return ["—", ""];
  const parts = a
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [parts[0] || "—", ""];
  return [parts[0], parts.slice(1).join(", ")];
}

// Count-free labels only — the exact van count often changes before move day, so
// the customer surfaces never name it (a generic vehicle type is fine, a count is not).
const VEHICLE_LABEL: Record<string, string> = {
  transit: "Removal van",
  "1luton": "Luton van",
  "2luton": "Luton van",
  "3luton": "Luton van",
};
const PACKING_LABEL: Record<string, string> = {
  owner: "Owner pack",
  fragile: "Fragile only",
  full: "Full pack",
};

export interface QuoteEmailMeta {
  quoteRef: string;
  /** Online accept page (/q/<token>) — the primary CTA when present; the email
   *  falls back to reply-to-confirm without it. */
  acceptUrl?: string;
  /** Booking deposit £ (Settings) — used in the "what happens next" copy. */
  depositAmount?: number;
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
  /** Card-at-accept availability for NON-default brands (global AND brand
   *  card switches, PRD §11.10). Ignored for marley — its literals stand. */
  offerCard?: boolean;
}

/** The deposit-step copy for the accept-link path: today's literal for
 *  marley, card wording gated by the brand's card switches otherwise. */
function depositStepCopy(m: QuoteEmailMeta): string {
  // `offerCard` overrides; otherwise the theme derives it from the brand's own
  // switch. It used to be the ONLY source, and no caller ever set it — so a
  // non-default brand could never be given card copy however its Settings
  // toggle was flipped (QA-20260826-07). Marley keeps card copy either way:
  // its row seeds the switch on, and the default theme reports it true.
  const t = emailTheme(m.brand, m.offerCard === undefined ? undefined : { cardPhone: m.offerCard });
  return t.cardPhone
    ? "Pay by card or bank transfer straight after accepting. This secures your booking; confirming your date then locks it in."
    : "Pay by bank transfer straight after accepting. This secures your booking; confirming your date then locks it in.";
}

/**
 * Send-time variables for the published `quote-email` Resend template (copy
 * editable in the dashboard, no deploy). Accept-link variant only — returns
 * null without an acceptUrl so the caller falls back to buildQuoteEmailHtml.
 * Keep the slot names in step with scripts/create-resend-templates.mjs.
 */
export function quoteEmailTemplateVars(
  values: QuoteFormValues,
  b: QuoteBreakdown,
  meta: QuoteEmailMeta,
): Record<string, string> | null {
  if (!meta.acceptUrl) return null;
  const t = emailTheme(meta.brand);
  const UK = "Europe/London";
  const job = values.job;
  const parseDate = (s: string) => new Date(s + (s.length === 10 ? "T00:00:00" : ""));
  const moveDate = job.moveDate ? parseDate(job.moveDate) : null;
  const moveDateValid = !!moveDate && !isNaN(moveDate.getTime());

  const moveDateClause = moveDateValid
    ? ` on <strong style="color:#1A1A1A;">${moveDate!.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: UK })}${
        job.moveDateEstimated ? " (estimated)" : ""
      }</strong>`
    : "";
  const estSuffix = job.moveDateEstimated
    ? ' <span style="color:#92400E;font-weight:400;font-size:11px;">(estimated)</span>'
    : "";
  const moveDateGlance = !job.moveDate
    ? "TBC"
    : moveDateValid
      ? moveDate!.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: UK }) + estSuffix
      : escapeHtml(job.moveDate) + estSuffix;

  const [c1, c2] = splitAddr(job.collectAddr);
  const [d1, d2] = splitAddr(job.destAddr);
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: UK,
  });

  return {
    CUSTOMER_FIRST_NAME: (values.customer.name || "").trim().split(/\s+/)[0] || "there",
    QUOTE_REF: escapeHtml(meta.quoteRef || ""),
    GRAND_TOTAL: gbp(b.grandTotal),
    TOTAL_COST_NOTE: b.vatEnabled ? "Fixed price, all inclusive · VAT @ 20%" : "Fixed price, all inclusive",
    EXPIRY_DATE: expiry,
    QUOTE_INTRO: `Here is your written fixed price for your move${moveDateClause}.`,
    COLLECTION_HTML: escapeHtml(c1) + (c2 ? "<br>" + escapeHtml(c2) : ""),
    DESTINATION_HTML: escapeHtml(d1) + (d2 ? "<br>" + escapeHtml(d2) : ""),
    MOVE_DATE_GLANCE: moveDateGlance,
    VEHICLE: escapeHtml(VEHICLE_LABEL[values.vehicle] || "—"),
    PACKING: escapeHtml(PACKING_LABEL[values.packing] || "—"),
    ACCEPT_URL: meta.acceptUrl,
    REPLY_HREF: `mailto:${t.helloAddress}?subject=${encodeURIComponent("Confirming quote " + meta.quoteRef)}`,
    DEPOSIT_AMOUNT: gbp(meta.depositAmount ?? 100),
    ISSUED_DATE: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: UK }),
  };
}

export function buildQuoteEmailHtml(
  values: QuoteFormValues,
  b: QuoteBreakdown,
  meta: QuoteEmailMeta,
): string {
  const t = emailTheme(meta.brand);
  const ref = escapeHtml(meta.quoteRef || "");
  const customer = values.customer;
  const job = values.job;

  // Customer-facing dates are always UK wall-clock (server runs UTC).
  const UK = "Europe/London";
  const issued = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: UK });
  const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const expiry = expiryDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: UK });

  const parseDate = (s: string) => new Date(s + (s.length === 10 ? "T00:00:00" : ""));

  const moveDateForSubline = (() => {
    if (!job.moveDate) return null;
    const d = parseDate(job.moveDate);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: UK });
  })();
  const moveDateForGlance = (() => {
    if (!job.moveDate) return "TBC";
    const d = parseDate(job.moveDate);
    if (isNaN(d.getTime())) return escapeHtml(job.moveDate);
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: UK });
  })();

  const firstName = (customer.name || "").trim().split(/\s+/)[0] || null;
  const headlineName = firstName ? `, ${escapeHtml(firstName)}` : "";
  const estSuffix = job.moveDateEstimated
    ? ' <span style="color:#92400E;font-weight:400;font-size:11px;">(estimated)</span>'
    : "";

  const lockIn = meta.acceptUrl ? "Accept online in 30 seconds to lock it in" : "Reply to lock it in";
  const subline = moveDateForSubline
    ? `Here is the full price for your move on <strong style="color:#1A1A1A;">${moveDateForSubline}${
        job.moveDateEstimated ? " (estimated)" : ""
      }</strong>. ${lockIn}, or ${t.callHtml} if anything needs changing.`
    : `Here is the full price for your move. ${lockIn}, or ${t.callHtml} if anything needs changing.`;

  const totalCostNote = b.vatEnabled ? "Fixed price, all inclusive · VAT @ 20%" : "Fixed price, all inclusive";

  const [collectLine1, collectLine2] = splitAddr(job.collectAddr);
  const [destLine1, destLine2] = splitAddr(job.destAddr);
  const ce = escapeHtml(collectLine1);
  const ce2 = escapeHtml(collectLine2);
  const de = escapeHtml(destLine1);
  const de2 = escapeHtml(destLine2);

  const vehicleLabel = VEHICLE_LABEL[values.vehicle] || "—";
  const packingLabel = PACKING_LABEL[values.packing] || "—";

  const replyHref = `mailto:${t.helloAddress}?subject=${encodeURIComponent("Confirming quote " + meta.quoteRef)}`;
  const ctaHref = meta.acceptUrl ?? replyHref;
  const ctaLabel = meta.acceptUrl ? "Accept your quote online &rarr;" : "Reply to confirm this quote &rarr;";
  const depositLabel = gbp(meta.depositAmount ?? 100);
  const groupRow = t.groupLine
    ? `\n          <div style="margin-top:2px;">${escapeHtml(t.groupLine)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Quote from ${escapeHtml(t.name)}</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your removal quote from ${escapeHtml(t.name)}: ${gbp(b.grandTotal)}. PDF attached.</div>

<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">

  <tr><td align="center" style="padding:34px 36px 8px;">
    ${t.logoHtml}
  </td></tr>

${themedPill(`Ref ${ref}`, t)}

  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">Your move is quoted${headlineName}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 22px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">${subline}</p>
  </td></tr>

  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="padding:22px 26px;border-left:4px solid ${t.accent};">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.22em;color:#6E6A65;margin-bottom:6px;">Total Move Cost</div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:42px;font-weight:700;color:#1A1A1A;letter-spacing:-0.02em;line-height:1;">${gbp(b.grandTotal)}</div>
          <div style="font-size:11px;color:#6E6A65;margin-top:6px;">${totalCostNote}</div>
        </td>
        <td align="right" valign="middle" style="padding:22px 26px;border-left:1px solid #EAE7E2;width:150px;">
          <div style="font-size:10px;color:#6E6A65;text-transform:uppercase;letter-spacing:0.18em;">Expires</div>
          <div style="font-size:14px;color:#1A1A1A;font-weight:700;margin-top:4px;">${expiry}</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 24px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:10px;">Job at a glance</div>
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top" style="width:46%;">
            <div style="font-size:10px;color:#6E6A65;letter-spacing:0.1em;text-transform:uppercase;">Collection</div>
            <div style="font-size:13px;color:#1A1A1A;font-weight:600;margin-top:4px;line-height:1.45;">${ce}${ce2 ? "<br>" + ce2 : ""}</div>
          </td>
          <td align="center" valign="middle" style="width:8%;font-size:18px;color:${t.accent};font-weight:600;">&rarr;</td>
          <td valign="top" style="width:46%;">
            <div style="font-size:10px;color:#6E6A65;letter-spacing:0.1em;text-transform:uppercase;">Destination</div>
            <div style="font-size:13px;color:#1A1A1A;font-weight:600;margin-top:4px;line-height:1.45;">${de}${de2 ? "<br>" + de2 : ""}</div>
          </td>
        </tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid #EAE7E2;padding-top:14px;"><tr>
          <td style="width:34%;font-size:11px;color:#6E6A65;vertical-align:top;">
            <div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Date</div>
            <div style="color:#1A1A1A;font-weight:600;margin-top:2px;">${moveDateForGlance}${estSuffix}</div>
          </td>
          <td style="width:33%;font-size:11px;color:#6E6A65;vertical-align:top;">
            <div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Vehicle</div>
            <div style="color:#1A1A1A;font-weight:600;margin-top:2px;">${escapeHtml(vehicleLabel)}</div>
          </td>
          <td style="width:33%;font-size:11px;color:#6E6A65;vertical-align:top;">
            <div style="letter-spacing:0.1em;text-transform:uppercase;font-size:9px;">Packing</div>
            <div style="color:#1A1A1A;font-weight:600;margin-top:2px;">${escapeHtml(packingLabel)}</div>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>

  <tr><td align="center" style="padding:0 36px ${meta.acceptUrl ? "10px" : "22px"};">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${t.accent}" style="border-radius:6px;">
      <a href="${ctaHref}" style="display:inline-block;padding:15px 38px;background:${t.accent};color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">${ctaLabel}</a>
    </td></tr></table>
  </td></tr>${
    meta.acceptUrl
      ? `
  <tr><td align="center" style="padding:0 36px 22px;">
    <p style="font-size:11px;color:#9CA3AF;margin:0;">Prefer email? <a href="${replyHref}" style="color:#6E6A65;">Reply to confirm</a> instead.</p>
  </td></tr>`
      : ""
  }

  <tr><td style="padding:8px 36px 28px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:14px;">What happens next</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:33%;vertical-align:top;padding-right:10px;">
        <div style="width:30px;height:30px;background:#1A1A1A;color:#FFFFFF;text-align:center;line-height:30px;font-size:13px;font-weight:700;font-family:Georgia,'Times New Roman',serif;border-radius:50%;">1</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A;margin-top:8px;">${meta.acceptUrl ? "Accept your quote" : "Reply to confirm"}</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:3px;line-height:1.5;">${
          meta.acceptUrl
            ? "Tap the button above (takes about 30 seconds) and your price is locked in."
            : "Just hit reply and let us know you are happy with the price."
        }</div>
      </td>
      <td style="width:34%;vertical-align:top;padding-right:10px;">
        <div style="width:30px;height:30px;background:#1A1A1A;color:#FFFFFF;text-align:center;line-height:30px;font-size:13px;font-weight:700;font-family:Georgia,'Times New Roman',serif;border-radius:50%;">2</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A;margin-top:8px;">${depositLabel} deposit</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:3px;line-height:1.5;">${
          meta.acceptUrl
            ? depositStepCopy(meta)
            : "Secures your booking and the team. Bank details are on the attached PDF."
        }</div>
      </td>
      <td style="width:33%;vertical-align:top;">
        <div style="width:30px;height:30px;background:#1A1A1A;color:#FFFFFF;text-align:center;line-height:30px;font-size:13px;font-weight:700;font-family:Georgia,'Times New Roman',serif;border-radius:50%;">3</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A;margin-top:8px;">Move day</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:3px;line-height:1.5;">We arrive on time. Balance due on completion.</div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="background:#FAFAFA;border-top:1px solid #EAE7E2;padding:20px 36px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:11px;color:#6E6A65;line-height:1.7;">
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:600;color:#1A1A1A;">${t.footerIdentityHtml}</div>${groupRow}
          <div style="margin-top:2px;">${t.footerMetaHtml}</div>
        </td>
        <td align="right" style="font-size:11px;color:#6E6A65;line-height:1.7;">
          <div><a href="${t.telHref}" style="color:#1A1A1A;text-decoration:none;font-weight:600;">${escapeHtml(t.phone)}</a></div>
          <div><a href="${t.websiteUrl}" style="color:#6E6A65;text-decoration:none;">${escapeHtml(t.websiteLabel)}</a></div>
        </td>
      </tr>
      <tr>
        <td colspan="2" style="padding-top:14px;">
          <div style="font-size:10px;color:#9CA3AF;line-height:1.5;">Issued ${issued} · valid 30 days · ref ${ref}. Prices are subject to a site survey where applicable.</div>
        </td>
      </tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
