/**
 * Survey emails — the customer's "it's in the diary" moment, the "it has moved"
 * follow-up, and the estimator's own heads-up.
 *
 * Sent from createAppointment / rescheduleAppointment. Same house style as the
 * quote email: logo on white, Georgia headline, brand-red accents. UK English,
 * no em-dash.
 *
 * Customer-facing copy carries the address because the customer already knows
 * where they live. The ESTIMATOR email is internal, so it may also carry the
 * customer's phone number and the booking notes — none of which may ever appear
 * in a push payload (see lib/push/categories.ts: first name only, lock screens
 * are readable by anyone holding the phone).
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): the CUSTOMER builders take an
 * optional `brand` on their input; absent/marley renders today's exact bytes
 * via the default theme in lib/comms/email-brand.ts. The estimator heads-up is
 * an internal staff surface and stays on the Marley identity deliberately.
 *
 * Pure server util — no React, no DOM. Returns strings.
 */

import type { Brand } from "@/lib/brand";
import { emailTheme, themedDarkFooter, type EmailTheme } from "@/lib/comms/email-brand";

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
  /** Sending brand — absent/marley renders today's exact bytes. */
  brand?: Brand | null;
}

/** A reschedule restates the new slot and names the old one, so the customer can
 *  see at a glance which of the two emails in their inbox is the live one. */
export interface SurveyRescheduleInput extends SurveyConfirmInput {
  /** "Thursday 10 July at 14:00" — the slot being replaced. */
  previousLabel: string | null;
}

/* --------------------------------------------------------------- shared shell */

function fact(label: string, value: string): string {
  return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;width:38%;">${label}</td>
        <td style="padding:10px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#1A1A1A;font-weight:600;">${value}</td>
      </tr>`;
}

/** The branded wrapper every survey email shares. `facts` is pre-built rows. */
function shell(opts: {
  title: string;
  preheader: string;
  badge: string;
  headline: string;
  intro: string;
  facts: string;
  footerNote: string;
  theme?: EmailTheme;
}): string {
  const t = opts.theme ?? emailTheme();
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)} | ${escapeHtml(t.name)}</title></head>
<body style="margin:0;padding:0;background:#F6F5F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F6F5F3;">${opts.preheader}</div>

<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F5F3;padding:32px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden;border:1px solid #E8E4DD;">

  <tr><td align="center" style="padding:34px 36px 8px;">
    ${t.logoHtml}
  </td></tr>

  <tr><td align="center" style="padding:0 36px 24px;">
    <div style="display:inline-block;padding:6px 14px;background:${t.pillBg};border:1px solid ${t.pillBorder};border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${t.accent};">${opts.badge}</div>
  </td></tr>

  <tr><td align="center" style="padding:0 36px 6px;">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:600;color:#1A1A1A;letter-spacing:-0.02em;line-height:1.18;margin:0;">${opts.headline}</h1>
  </td></tr>
  <tr><td align="center" style="padding:14px 36px 22px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0 auto;max-width:440px;">${opts.intro}</p>
  </td></tr>

  <tr><td style="padding:0 36px 22px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1.5px solid #1A1A1A;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:20px 26px;border-left:4px solid ${t.accent};">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${opts.facts}
        </table>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 36px 26px;">
    <p style="font-size:14px;color:#5A554F;line-height:1.65;margin:0;">${opts.footerNote}</p>
  </td></tr>

${themedDarkFooter(t)}

</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The "When / Who / Where / How long" block both customer emails share. */
function visitFacts(i: SurveyConfirmInput, whenLabel: string): string {
  const who = i.estimatorName ? escapeHtml(i.estimatorName) : "One of our team";
  const addr = i.address ? escapeHtml(i.address) : null;
  return [
    fact(whenLabel, `${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}`),
    fact("Who's coming", who),
    addr ? fact("Where", addr) : "",
    `
          <tr>
            <td style="padding:10px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">How long</td>
            <td style="padding:10px 0;font-size:14px;color:#1A1A1A;font-weight:600;">About 1 hour</td>
          </tr>`,
  ].join("");
}

const changeNote = (t: EmailTheme): string =>
  `Need to change the time? Just ${t.callUsHtml} or reply to this email and we'll sort it.`;

/* ------------------------------------------------------------ survey booked */

export function surveyConfirmSms(i: SurveyConfirmInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || "there";
  const who = i.estimatorName ? `${i.estimatorName} from ${t.name}` : `One of the ${t.name} team`;
  const where = i.address ? ` at ${i.address}` : "";
  return (
    `Hi ${first}, your free home survey is booked for ${i.dateLabel} at ${i.timeLabel}. ` +
    `${who} will visit you${where}. Need to change it? Call ${t.phone}. ${t.name}`
  );
}

export function surveyConfirmSubject(i: SurveyConfirmInput): string {
  return `Your survey is booked: ${i.dateLabel}, ${i.timeLabel}`;
}

export function surveyConfirmEmailHtml(i: SurveyConfirmInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || null;
  return shell({
    title: "Survey booked",
    preheader: `Your free home survey with ${escapeHtml(t.name)} is booked for ${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}.`,
    badge: "Survey booked",
    headline: `You're in the diary${first ? `, ${escapeHtml(first)}` : ""}`,
    intro:
      "We'll come and take a proper look at your move so your fixed quote covers everything. The visit takes about an hour and there is nothing to prepare.",
    facts: visitFacts(i, "When"),
    footerNote: changeNote(t),
    theme: t,
  });
}

export function surveyConfirmEmailText(i: SurveyConfirmInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || "there";
  const who = i.estimatorName ? `${i.estimatorName} from ${t.name}` : `One of the ${t.name} team`;
  return [
    `Hi ${first},`,
    ``,
    `Your free home survey is booked for ${i.dateLabel} at ${i.timeLabel}.`,
    `${who} will come and take a proper look at your move so your fixed quote covers everything.${i.address ? ` The visit is at ${i.address}.` : ""} It takes about an hour and there is nothing to prepare.`,
    ``,
    `Need to change the time? Call ${t.phone} or reply to this email.`,
    ``,
    `${t.name} · ${t.phone} · ${t.helloAddress}`,
  ].join("\n");
}

/* --------------------------------------------------------- survey moved */

export function surveyRescheduleSubject(i: SurveyRescheduleInput): string {
  return `Your survey has moved: ${i.dateLabel}, ${i.timeLabel}`;
}

export function surveyRescheduleSms(i: SurveyRescheduleInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || "there";
  const who = i.estimatorName ? `${i.estimatorName} from ${t.name}` : `One of the ${t.name} team`;
  return (
    `Hi ${first}, your ${t.name} survey has been moved to ${i.dateLabel} at ${i.timeLabel}. ` +
    `${who} will visit you then. Not right? Call ${t.phone}. ${t.name}`
  );
}

export function surveyRescheduleEmailHtml(i: SurveyRescheduleInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || null;
  const facts =
    visitFacts(i, "New time") +
    (i.previousLabel
      ? `
          <tr>
            <td style="padding:10px 0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Was</td>
            <td style="padding:10px 0;font-size:14px;color:#8A857E;font-weight:500;text-decoration:line-through;">${escapeHtml(i.previousLabel)}</td>
          </tr>`
      : "");
  return shell({
    title: "Survey moved",
    preheader: `Your survey with ${escapeHtml(t.name)} has moved to ${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}.`,
    badge: "New time",
    headline: `Your survey has moved${first ? `, ${escapeHtml(first)}` : ""}`,
    intro:
      "Everything else stays the same. The visit still takes about an hour and there is nothing to prepare. Please use this email rather than the earlier one.",
    facts,
    footerNote: `Does this new time not work? ${t.callUsHtmlCap} or reply to this email and we'll find another.`,
    theme: t,
  });
}

export function surveyRescheduleEmailText(i: SurveyRescheduleInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || "there";
  const who = i.estimatorName ? `${i.estimatorName} from ${t.name}` : `One of the ${t.name} team`;
  return [
    `Hi ${first},`,
    ``,
    `Your free home survey has been moved to ${i.dateLabel} at ${i.timeLabel}.`,
    i.previousLabel ? `It was previously booked for ${i.previousLabel}. Please use this email rather than the earlier one.` : "",
    `${who} will visit you then.${i.address ? ` The visit is at ${i.address}.` : ""} It still takes about an hour and there is nothing to prepare.`,
    ``,
    `Does this new time not work? Call ${t.phone} or reply to this email.`,
    ``,
    `${t.name} · ${t.phone} · ${t.helloAddress}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/* ----------------------------------------------------------- survey cancelled */

export function surveyCancelledSubject(i: SurveyConfirmInput): string {
  return `Your survey on ${i.dateLabel} has been cancelled`;
}

export function surveyCancelledSms(i: SurveyConfirmInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || "there";
  return (
    `Hi ${first}, we've had to cancel your ${t.name} survey on ${i.dateLabel} at ${i.timeLabel}, ` +
    `so please don't wait in. Call ${t.phone} and we'll rebook you. ${t.name}`
  );
}

export function surveyCancelledEmailHtml(i: SurveyConfirmInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || null;
  return shell({
    title: "Survey cancelled",
    preheader: `Your survey on ${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)} has been cancelled. Please don't wait in.`,
    badge: "Cancelled",
    headline: `Your survey has been cancelled${first ? `, ${escapeHtml(first)}` : ""}`,
    intro:
      "Sorry about this. Please don't wait in for us on that day. We'd still like to price up your move, so give us a call and we'll find another time that suits you.",
    facts: [
      fact("Cancelled visit", `${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}`),
      i.address ? fact("Was at", escapeHtml(i.address)) : "",
    ].join(""),
    footerNote: `To rebook, ${t.callUsHtml} or just reply to this email.`,
    theme: t,
  });
}

export function surveyCancelledEmailText(i: SurveyConfirmInput): string {
  const t = emailTheme(i.brand);
  const first = (i.customerName || "").trim().split(/\s+/)[0] || "there";
  return [
    `Hi ${first},`,
    ``,
    `Sorry, we've had to cancel your free home survey on ${i.dateLabel} at ${i.timeLabel}. Please don't wait in for us that day.`,
    ``,
    `We'd still like to price up your move properly. Call ${t.phone} or reply to this email and we'll find another time.`,
    ``,
    `${t.name} · ${t.phone} · ${t.helloAddress}`,
  ].join("\n");
}

/* ------------------------------------------------- estimator's own heads-up */

export interface EstimatorSurveyInput {
  estimatorName: string | null;
  customerName: string | null;
  dateLabel: string;
  timeLabel: string;
  address: string | null;
  customerPhone: string | null;
  /** Booking notes typed by whoever booked it — the crew/visit context. */
  notes: string | null;
  /**
   * "removed" = handed to another estimator (the visit still happens).
   * "cancelled" = the visit isn't happening at all. Kept distinct because
   * telling someone "that one's covered" about a cancelled job would have them
   * assume a colleague is going.
   */
  kind: "booked" | "moved" | "removed" | "cancelled";
  /** The slot being replaced, when this is a move. */
  previousLabel: string | null;
  /** Deep link to the lead so the estimator lands on the full record. */
  leadUrl: string | null;
}

export function estimatorSurveySubject(i: EstimatorSurveyInput): string {
  const who = i.customerName || "a customer";
  if (i.kind === "removed") return `Survey reassigned: ${who}, ${i.dateLabel}`;
  if (i.kind === "cancelled") return `Survey cancelled: ${who}, ${i.dateLabel}`;
  const verb = i.kind === "moved" ? "moved" : "booked";
  return `Survey ${verb}: ${who}, ${i.dateLabel} at ${i.timeLabel}`;
}

export function estimatorSurveyEmailHtml(i: EstimatorSurveyInput): string {
  const first = (i.estimatorName || "").trim().split(/\s+/)[0] || null;
  if (i.kind === "cancelled") {
    return shell({
      title: "Survey cancelled",
      preheader: `The survey for ${escapeHtml(i.customerName || "a customer")} on ${escapeHtml(i.dateLabel)} is cancelled.`,
      badge: "Cancelled",
      headline: `That survey is off${first ? `, ${escapeHtml(first)}` : ""}`,
      intro: "This visit has been cancelled, so please don't travel. Nobody else is going either.",
      facts: [
        fact("Customer", escapeHtml(i.customerName || "Not named")),
        fact("Was", `${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}`),
        i.address ? fact("Was at", escapeHtml(i.address)) : "",
      ].join(""),
      footerNote: "If you think that's wrong, check with the office on 01747 637070.",
    });
  }
  if (i.kind === "removed") {
    return shell({
      title: "Survey reassigned",
      preheader: `The survey for ${escapeHtml(i.customerName || "a customer")} on ${escapeHtml(i.dateLabel)} is no longer yours.`,
      badge: "Off your diary",
      headline: `That one's covered${first ? `, ${escapeHtml(first)}` : ""}`,
      intro: "This survey has been reassigned to someone else. Nothing for you to do, and the slot is back in your day.",
      facts: [
        fact("Customer", escapeHtml(i.customerName || "Not named")),
        fact("Was", `${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}`),
      ].join(""),
      footerNote: "If you think that's wrong, check with the office on 01747 637070.",
    });
  }
  const facts = [
    fact("Customer", escapeHtml(i.customerName || "Not named")),
    fact(i.kind === "moved" ? "New time" : "When", `${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}`),
    i.kind === "moved" && i.previousLabel
      ? `
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid #F0EDE8;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8A857E;">Was</td>
            <td style="padding:10px 0;border-bottom:1px solid #F0EDE8;font-size:14px;color:#8A857E;font-weight:500;text-decoration:line-through;">${escapeHtml(i.previousLabel)}</td>
          </tr>`
      : "",
    i.address ? fact("Where", escapeHtml(i.address)) : "",
    i.customerPhone ? fact("Phone", `<a href="tel:${escapeHtml(i.customerPhone)}" style="color:#C03838;text-decoration:none;">${escapeHtml(i.customerPhone)}</a>`) : "",
    i.notes ? fact("Notes", escapeHtml(i.notes)) : "",
  ].join("");
  return shell({
    title: i.kind === "moved" ? "Survey moved" : "Survey booked for you",
    preheader: `${escapeHtml(i.customerName || "A customer")} — ${escapeHtml(i.dateLabel)} at ${escapeHtml(i.timeLabel)}.`,
    badge: i.kind === "moved" ? "Time changed" : "New survey",
    headline: i.kind === "moved" ? `A survey has moved${first ? `, ${escapeHtml(first)}` : ""}` : `You've got a survey${first ? `, ${escapeHtml(first)}` : ""}`,
    intro:
      i.kind === "moved"
        ? "One of your survey visits has been given a new time. The customer has been told separately."
        : "You've been booked in to visit this customer and price up their move. The customer has their own confirmation.",
    facts,
    footerNote: i.leadUrl
      ? `Full details, photos and the quote builder are on the panel: <a href="${escapeHtml(i.leadUrl)}" style="color:#C03838;text-decoration:none;font-weight:600;">open the customer's record</a>.`
      : "Full details are on the panel under the customer's record.",
  });
}

export function estimatorSurveyEmailText(i: EstimatorSurveyInput): string {
  const first = (i.estimatorName || "").trim().split(/\s+/)[0] || "there";
  const who = i.customerName || "a customer";
  if (i.kind === "cancelled") {
    return [
      `Hi ${first},`,
      ``,
      `The survey for ${who} on ${i.dateLabel} at ${i.timeLabel} has been cancelled. Please don't travel — nobody else is going either.`,
      `If you think that's wrong, check with the office on 01747 637070.`,
      ``,
      `Marley Moves`,
    ].join("\n");
  }
  if (i.kind === "removed") {
    return [
      `Hi ${first},`,
      ``,
      `The survey for ${who} on ${i.dateLabel} at ${i.timeLabel} has been reassigned to someone else.`,
      `Nothing for you to do. If you think that's wrong, check with the office on 01747 637070.`,
      ``,
      `Marley Moves`,
    ].join("\n");
  }
  return [
    `Hi ${first},`,
    ``,
    i.kind === "moved"
      ? `The survey for ${who} has moved to ${i.dateLabel} at ${i.timeLabel}.`
      : `You've been booked in to survey ${who} on ${i.dateLabel} at ${i.timeLabel}.`,
    i.kind === "moved" && i.previousLabel ? `It was previously ${i.previousLabel}.` : "",
    i.address ? `Where: ${i.address}` : "",
    i.customerPhone ? `Phone: ${i.customerPhone}` : "",
    i.notes ? `Notes: ${i.notes}` : "",
    ``,
    `The customer has had their own confirmation.`,
    i.leadUrl ? `Full details: ${i.leadUrl}` : `Full details are on the panel under the customer's record.`,
    ``,
    `Marley Moves`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
