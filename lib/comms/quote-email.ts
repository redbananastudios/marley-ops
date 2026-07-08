/**
 * Branded customer quote email — port of the live MM Quotes "Option B"
 * (service-forward) template from quotes-app/api/send-quote.js buildEmailHtml().
 *
 * Logo on white, "Your move is quoted, {firstName}", total card driven by
 * grandTotal, route arrow collect -> dest, "What happens next" (incl. the
 * £100 deposit step), and a reply-to-confirm CTA. UK English, no em-dash.
 *
 * Pure server util — no React, no DOM. Returns an HTML string.
 */

import type { QuoteBreakdown } from "@/lib/quote/pricing";
import type { QuoteFormValues } from "@/lib/quote/form-types";

const LOGO_URL = "https://quotes.marleymoves.co.uk/logo.png";

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

const VEHICLE_LABEL: Record<string, string> = {
  "1luton": "1 Luton van",
  "2luton": "2 Luton vans",
  "3luton": "3 Luton vans",
};
const PACKING_LABEL: Record<string, string> = {
  owner: "Owner pack",
  fragile: "Fragile only",
  full: "Full pack",
};

export interface QuoteEmailMeta {
  quoteRef: string;
}

export function buildQuoteEmailHtml(
  values: QuoteFormValues,
  b: QuoteBreakdown,
  meta: QuoteEmailMeta,
): string {
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

  const subline = moveDateForSubline
    ? `Here is the full price for your move on <strong style="color:#1A1A1A;">${moveDateForSubline}${
        job.moveDateEstimated ? " (estimated)" : ""
      }</strong>. Reply to lock it in, or call Connor on <strong style="color:#C03838;">01747 637070</strong> if anything needs changing.`
    : `Here is the full price for your move. Reply to lock it in, or call Connor on <strong style="color:#C03838;">01747 637070</strong> if anything needs changing.`;

  const totalCostNote = b.vatEnabled ? "Includes admin fee · VAT @ 20%" : "Includes admin fee · no VAT";

  const [collectLine1, collectLine2] = splitAddr(job.collectAddr);
  const [destLine1, destLine2] = splitAddr(job.destAddr);
  const ce = escapeHtml(collectLine1);
  const ce2 = escapeHtml(collectLine2);
  const de = escapeHtml(destLine1);
  const de2 = escapeHtml(destLine2);

  const vehicleLabel = VEHICLE_LABEL[values.vehicle] || "—";
  const packingLabel = PACKING_LABEL[values.packing] || "—";

  const replyHref = `mailto:hello@marleymoves.co.uk?subject=${encodeURIComponent("Confirming quote " + meta.quoteRef)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Quote — Marley Moves</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">Your removal quote from Marley Moves — ${gbp(b.grandTotal)}. PDF attached.</div>

<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">

  <tr><td align="center" style="padding:34px 36px 8px;">
    <img src="${LOGO_URL}" alt="Marley Moves" width="180" style="display:block;margin:0 auto;max-width:60%;border:0;outline:none;text-decoration:none;">
  </td></tr>

  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:#FFF3F1;border:1px solid #F5C9C4;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#C03838;">Ref ${ref}</div>
  </td></tr>

  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">Your move is quoted${headlineName}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 22px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">${subline}</p>
  </td></tr>

  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="padding:22px 26px;border-left:4px solid #C03838;">
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
          <td align="center" valign="middle" style="width:8%;font-size:18px;color:#C03838;font-weight:600;">&rarr;</td>
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

  <tr><td align="center" style="padding:0 36px 22px;">
    <table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#C03838" style="border-radius:6px;">
      <a href="${replyHref}" style="display:inline-block;padding:15px 38px;background:#C03838;color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;letter-spacing:0.04em;">Reply to confirm this quote &rarr;</a>
    </td></tr></table>
  </td></tr>

  <tr><td style="padding:8px 36px 28px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#6E6A65;margin-bottom:14px;">What happens next</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:33%;vertical-align:top;padding-right:10px;">
        <div style="width:30px;height:30px;background:#1A1A1A;color:#FFFFFF;text-align:center;line-height:30px;font-size:13px;font-weight:700;font-family:Georgia,'Times New Roman',serif;border-radius:50%;">1</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A;margin-top:8px;">Reply to confirm</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:3px;line-height:1.5;">Just hit reply and let us know you are happy with the price.</div>
      </td>
      <td style="width:34%;vertical-align:top;padding-right:10px;">
        <div style="width:30px;height:30px;background:#1A1A1A;color:#FFFFFF;text-align:center;line-height:30px;font-size:13px;font-weight:700;font-family:Georgia,'Times New Roman',serif;border-radius:50%;">2</div>
        <div style="font-size:13px;font-weight:600;color:#1A1A1A;margin-top:8px;">£100 deposit</div>
        <div style="font-size:11px;color:#6E6A65;margin-top:3px;line-height:1.5;">Secures the date and the team. Bank details are on the attached PDF.</div>
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
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:600;color:#1A1A1A;">Marley <span style="color:#C03838;">Moves</span></div>
          <div style="margin-top:2px;">Shaftesbury, SP7 · Company No. 15914266</div>
        </td>
        <td align="right" style="font-size:11px;color:#6E6A65;line-height:1.7;">
          <div><a href="tel:01747637070" style="color:#1A1A1A;text-decoration:none;font-weight:600;">01747 637070</a></div>
          <div><a href="https://marleymoves.co.uk" style="color:#6E6A65;text-decoration:none;">marleymoves.co.uk</a></div>
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
