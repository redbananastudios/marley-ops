/**
 * What the office is actually told after a refund_queue row is settled.
 *
 * The Complete and Retain dialogs used to say "customer emailed." unconditionally
 * (QA-20260823-03), while the server had several outcomes — including one that
 * notified nobody at all. Claiming a customer was told when they were not is the
 * expensive direction of that error: the office moves on believing the customer
 * knows their money is coming back.
 *
 * Reading the branch also turned up a fourth case the finding did not name: on
 * the Complete path a quote WITH an email but no refund lines fell between the
 * `if` and the `else if`, so neither the customer nor ops heard anything. It is
 * `nothing_to_send` here, so it can never be silent again.
 */

export type CustomerNotice =
  | "sent" /* dispatchComm accepted it */
  | "already_sent" /* duplicate-guarded — the customer already has this one */
  | "failed" /* provider refused; ops alerted, customer NOT told */
  | "no_email" /* nothing on file; ops alerted, customer NOT told */
  | "nothing_to_send"; /* no lines to itemise — nobody was told anything */

/** The shape dispatchComm returns, narrowed to what this decision needs. */
export type DispatchOutcome =
  | { ok: true }
  | { ok: false; error?: string }
  | { duplicate: true }
  | null;

export function customerNoticeOutcome(f: {
  hasEmail: boolean;
  /** Complete itemises refund lines; Retain always has something to say. */
  hasLines: boolean;
  dispatch: DispatchOutcome;
}): CustomerNotice {
  if (!f.hasEmail) return "no_email";
  if (!f.hasLines) return "nothing_to_send";
  const d = f.dispatch;
  if (d && "duplicate" in d && d.duplicate) return "already_sent";
  if (d && "ok" in d && d.ok) return "sent";
  return "failed";
}

/** One sentence for the office, true to what actually happened.
 *
 *  An ABSENT notice (an older server, or a path that sends nothing at all)
 *  makes no claim either way — defaulting it to "sent" would reintroduce
 *  exactly the lie this exists to remove. */
export function customerNoticeLabel(n: CustomerNotice | undefined, verb: string): string {
  if (!n) return `${verb}.`;
  switch (n) {
    case "sent":
      return `${verb} — customer emailed.`;
    case "already_sent":
      return `${verb} — the customer already had this email, so it was not sent twice.`;
    case "failed":
      return `${verb}, but the customer email FAILED to send. Accounts have been alerted — tell them another way.`;
    case "no_email":
      return `${verb}, but there is no email address on file. The customer has NOT been told — accounts have been alerted.`;
    case "nothing_to_send":
      return `${verb}. There was nothing to itemise, so no customer email was sent.`;
  }
}
