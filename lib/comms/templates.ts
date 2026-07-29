/**
 * Canned follow-up messages (v1: three, hardcoded). Pure functions — the queue page
 * fills the variables and the staff member can edit before sending. UK English,
 * no em dashes, short and human.
 */

export interface TemplateContext {
  firstName?: string | null;
  quoteRef?: string | null;
  amount?: number | null;
  moveDate?: string | null; // already formatted, e.g. "14 Jul"
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

export function missedCallTemplate(c: TemplateContext): MessageTemplate {
  const name = first(c);
  return {
    key: "missed_call",
    label: "Missed call",
    subject: "We tried to reach you about your move",
    email: `Hi ${name},

We tried to give you a call about your move enquiry but couldn't get hold of you.

We'd love to help. Reply to this email or call us back on 01747 637070 and we'll pick it straight up.

Thanks,
Marley Moves`,
    sms: `Hi ${name}, it's Marley Moves. We tried calling about your move enquiry. Call us back on 01747 637070 or reply here and we'll sort it. Thanks!`,
  };
}

export function depositReminderTemplate(c: TemplateContext): MessageTemplate {
  const name = first(c);
  const amt = gbp(c.amount);
  const ref = c.quoteRef ? ` (quote ${c.quoteRef})` : "";
  const when = c.moveDate ? ` for your move on ${c.moveDate}` : "";
  return {
    key: "deposit_reminder",
    label: "Deposit reminder",
    subject: `Your deposit${ref ? ` (quote ${c.quoteRef})` : ""}`,
    email: `Hi ${name},

Just a gentle reminder that the ${amt} deposit${ref}${when} is still outstanding. Once it's in, your date is locked and we're all set.

If you've already sent it, please ignore this. Any questions, call 01747 637070.

Thanks,
Marley Moves`,
    sms: `Hi ${name}, Marley Moves here. A quick reminder the ${amt} deposit${when} is still outstanding. Once paid your date is secured. Questions? 01747 637070.`,
  };
}

export function balanceReminderTemplate(c: TemplateContext): MessageTemplate {
  const name = first(c);
  const amt = gbp(c.amount);
  const when = c.moveDate ? ` for your move on ${c.moveDate}` : "";
  return {
    key: "balance_reminder",
    label: "Balance reminder",
    subject: `Remaining balance${c.quoteRef ? ` (quote ${c.quoteRef})` : ""}`,
    email: `Hi ${name},

A quick reminder that the remaining balance of ${amt}${when} is now due.

If you've already paid, please ignore this. Any questions at all, call us on 01747 637070.

Thanks,
Marley Moves`,
    sms: `Hi ${name}, Marley Moves here. The remaining balance of ${amt}${when} is now due. Already paid? Please ignore this. Questions? 01747 637070.`,
  };
}

export function templateForReason(reason: string, c: TemplateContext): MessageTemplate {
  if (reason === "deposit") return depositReminderTemplate(c);
  if (reason === "balance") return balanceReminderTemplate(c);
  return missedCallTemplate(c);
}
