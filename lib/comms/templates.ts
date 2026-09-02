/**
 * Canned follow-up messages (v1: three, hardcoded). Pure functions — the queue page
 * fills the variables and the staff member can edit before sending. UK English,
 * no em dashes, short and human.
 *
 * Multi-brand (docs/multi-brand-prd.md §3.5): where the copy names the brand or
 * its phone number, `brandName`/`brandPhone` in the context drive it. Both
 * default to the Marley literals, so a context without them (every existing
 * call site) produces byte-identical copy to today. The phone fallback is
 * default-brand ONLY: a named non-default brand with a blank phone degrades to
 * reply-first copy that names no number (see `phone` below).
 */

export interface TemplateContext {
  firstName?: string | null;
  quoteRef?: string | null;
  amount?: number | null;
  moveDate?: string | null; // already formatted, e.g. "14 Jul"
  /** Brand display name for sign-offs and "it's X" lines; default Marley Moves. */
  brandName?: string | null;
  /** Brand phone for callback lines; default Marley's number for the default
   *  brand only — a named non-default brand with no phone gets no number. */
  brandPhone?: string | null;
}

export interface MessageTemplate {
  key: "missed_call" | "deposit_reminder" | "balance_reminder";
  label: string;
  subject: string;
  email: string;
  sms: string;
}

const gbp = (n: number | null | undefined): string =>
  n != null && Number.isFinite(n) ? `£${Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}` : "£—";

const first = (c: TemplateContext): string => (c.firstName ?? "").trim().split(/\s+/)[0] || "there";

const brand = (c: TemplateContext): string => (c.brandName ?? "").trim() || "Marley Moves";

/**
 * The Marley office number is the DEFAULT-BRAND fallback only. A context that
 * names another brand but carries no phone returns null, and the copy degrades
 * to reply-first contact — a Pitmans follow-up must never hand the customer
 * Marley's number under a Pitmans sign-off, and a made-up number is worse.
 */
const phone = (c: TemplateContext): string | null => {
  const tel = (c.brandPhone ?? "").trim();
  if (tel) return tel;
  return brand(c) === "Marley Moves" ? "01747 637070" : null;
};

export function missedCallTemplate(c: TemplateContext): MessageTemplate {
  const name = first(c);
  const co = brand(c);
  const tel = phone(c);
  return {
    key: "missed_call",
    label: "Missed call",
    subject: "We tried to reach you about your move",
    email: `Hi ${name},

We tried to give you a call about your move enquiry but couldn't get hold of you.

We'd love to help. ${tel ? `Reply to this email or call us back on ${tel}` : `Reply to this email`} and we'll pick it straight up.

Thanks,
${co}`,
    sms: `Hi ${name}, it's ${co}. We tried calling about your move enquiry. ${tel ? `Call us back on ${tel} or reply here` : `Reply here`} and we'll sort it. Thanks!`,
  };
}

export function depositReminderTemplate(c: TemplateContext): MessageTemplate {
  const name = first(c);
  const co = brand(c);
  const tel = phone(c);
  const amt = gbp(c.amount);
  const ref = c.quoteRef ? ` (quote ${c.quoteRef})` : "";
  const when = c.moveDate ? ` for your move on ${c.moveDate}` : "";
  return {
    key: "deposit_reminder",
    label: "Deposit reminder",
    subject: `Your deposit${ref ? ` (quote ${c.quoteRef})` : ""}`,
    email: `Hi ${name},

Just a gentle reminder that the ${amt} deposit${ref}${when} is still outstanding. Once it's in, your booking is secured and confirming your date is the next quick step.

If you've already sent it, please ignore this. ${tel ? `Any questions, call ${tel}.` : `Any questions, just reply to this email.`}

Thanks,
${co}`,
    sms: `Hi ${name}, ${co} here. A quick reminder the ${amt} deposit${when} is still outstanding. Once paid your booking is secured. Questions? ${tel ? `${tel}.` : "Just reply."}`,
  };
}

export function balanceReminderTemplate(c: TemplateContext): MessageTemplate {
  const name = first(c);
  const co = brand(c);
  const tel = phone(c);
  const amt = gbp(c.amount);
  const when = c.moveDate ? ` for your move on ${c.moveDate}` : "";
  return {
    key: "balance_reminder",
    label: "Balance reminder",
    subject: `Remaining balance${c.quoteRef ? ` (quote ${c.quoteRef})` : ""}`,
    email: `Hi ${name},

A quick reminder that the remaining balance of ${amt}${when} is now due.

If you've already paid, please ignore this. ${tel ? `Any questions at all, call us on ${tel}.` : `Any questions at all, just reply to this email.`}

Thanks,
${co}`,
    sms: `Hi ${name}, ${co} here. The remaining balance of ${amt}${when} is now due. Already paid? Please ignore this. Questions? ${tel ? `${tel}.` : "Just reply."}`,
  };
}

export function templateForReason(reason: string, c: TemplateContext): MessageTemplate {
  if (reason === "deposit") return depositReminderTemplate(c);
  if (reason === "balance") return balanceReminderTemplate(c);
  return missedCallTemplate(c);
}
