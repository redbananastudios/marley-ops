/**
 * Web Push category registry + copy builders (pure — no IO, fully tested).
 *
 * Every push the system can send is declared here: audience, TTL, urgency and
 * the exact lock-screen copy. Copy rules (PRD §15 + Peter 2026-07-15): FIRST
 * NAME ONLY — never an address, phone number or £ amount on a lock screen.
 * The deep link carries the reader to the authenticated record for detail.
 *
 * v1 ships two categories (Peter's picks): new_enquiry and payment_event.
 * Adding a category later = add it here + a business_settings kill column +
 * fire it from the event's authoritative commit point.
 */

export const PUSH_CATEGORIES = {
  new_enquiry: {
    id: "new_enquiry" as const,
    label: "New enquiries",
    description: "A website enquiry lands and needs review.",
    /** Office roles only — crew never receive these. */
    audience: ["admin", "estimator"] as const,
    defaultEnabled: true,
    /** A stale lead alert is noise — expire undelivered pushes after 4h. */
    ttlSeconds: 4 * 3600,
    /** The "never sits unseen" alarm — matches the in-app chime's urgency. */
    urgency: "high" as const,
    /** The in-app banner + chime own the moment while the app is focused —
     *  the OS notification only fires when the app is backgrounded/closed
     *  (Peter: "we already built in audio alerts so we need to stop any
     *  conflicts"). */
    suppressWhenFocused: true,
  },
  payment_event: {
    id: "payment_event" as const,
    label: "Payments",
    description: "A deposit or balance payment is received.",
    audience: ["admin", "estimator"] as const,
    defaultEnabled: true,
    ttlSeconds: 4 * 3600,
    urgency: "normal" as const,
    suppressWhenFocused: false,
  },
  crew_job: {
    id: "crew_job" as const,
    label: "Job assignments",
    description: "You're put on a job, or taken off one.",
    /** Targeted at the SPECIFIC assigned member, never broadcast (the sender
     *  only ever passes recipientUserIds for this category). All roles are in
     *  the audience because a staff record can link to an office login —
     *  Connor works jobs himself and still needs the ping. */
    audience: ["crew", "admin", "estimator"] as const,
    defaultEnabled: true,
    /** A day's shelf life — a crew member should still hear about yesterday's
     *  late-evening allocation when their phone wakes up in the morning. */
    ttlSeconds: 24 * 3600,
    urgency: "high" as const,
    suppressWhenFocused: false,
  },
  survey_assigned: {
    id: "survey_assigned" as const,
    label: "Your surveys",
    description: "A survey visit is booked onto you, moved, or handed to someone else.",
    /** Targeted at the SPECIFIC estimator (the sender only ever passes
     *  recipientUserIds for this category), never broadcast to the office.
     *  Admin is in the audience because Connor surveys jobs himself. */
    audience: ["estimator", "admin"] as const,
    defaultEnabled: true,
    /** A day's shelf life — an evening booking for tomorrow morning must still
     *  be waiting when the phone wakes up. */
    ttlSeconds: 24 * 3600,
    /** You are expected to turn up at someone's house — same urgency as a job. */
    urgency: "high" as const,
    suppressWhenFocused: false,
  },
  fleet_expiry: {
    id: "fleet_expiry" as const,
    label: "Fleet reminders",
    description: "A vehicle's MOT, tax, insurance, service or lease is due.",
    /** Office only — the people who book garage slots and renew documents. */
    audience: ["admin", "estimator"] as const,
    defaultEnabled: true,
    /** A heads-up, not an alarm — a day's shelf life is plenty. */
    ttlSeconds: 24 * 3600,
    urgency: "normal" as const,
    suppressWhenFocused: false,
  },
} satisfies Record<string, PushCategory>;

export type PushCategoryId = keyof typeof PUSH_CATEGORIES;

export interface PushCategory {
  id: string;
  label: string;
  description: string;
  audience: readonly string[];
  defaultEnabled: boolean;
  ttlSeconds: number;
  urgency: "normal" | "high";
  suppressWhenFocused: boolean;
}

export const PUSH_CATEGORY_IDS = Object.keys(PUSH_CATEGORIES) as PushCategoryId[];

export function isPushCategoryId(value: string): value is PushCategoryId {
  return value in PUSH_CATEGORIES;
}

/** What the sender fans out — everything a payload + delivery needs. */
export interface PushEvent {
  category: PushCategoryId;
  /** Business-event identity (drives the notification tag → OS-level dedupe/
   *  replacement if the same event is ever sent twice). */
  eventKey: string;
  title: string;
  body: string;
  /** Same-origin relative route the click opens. */
  url: string;
}

/** First name only — "Sarah Jane Smith" → "Sarah"; empty/garbage → fallback. */
export function firstNameOnly(name: string | null | undefined, fallback = "A customer"): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first) return fallback;
  // Title-case so "freddy" reads as "Freddy" — and bank-statement ALL-CAPS
  // ("JOHN DOE") stops shouting, while mixed case (McDonald) is left alone.
  const rest = first === first.toUpperCase() ? first.slice(1).toLowerCase() : first.slice(1);
  return first.charAt(0).toUpperCase() + rest;
}

/* ------------------------------------------------------------ copy builders */

export function newEnquiryPush(lead: { id: string; name: string | null }): PushEvent {
  return {
    category: "new_enquiry",
    eventKey: `enquiry-${lead.id}`,
    title: "New enquiry",
    body: `${firstNameOnly(lead.name, "Someone")} has asked for a quote.`,
    url: `/leads/${lead.id}`,
  };
}

/** Several web leads committed in one sync run (e.g. the go-live backfill) —
 *  ONE digest instead of a notification storm (PRD §15 "avoid storms"). */
export function newEnquiryDigestPush(count: number): PushEvent {
  return {
    category: "new_enquiry",
    eventKey: "enquiry-digest",
    title: "New enquiries",
    body: `${count} new website enquiries need review.`,
    url: "/leads",
  };
}

/** One daily digest push when vehicle documents cross a reminder threshold —
 *  a stable tag so a new day's digest replaces yesterday's unseen one. */
export function fleetExpiryDigestPush(count: number): PushEvent {
  return {
    category: "fleet_expiry",
    eventKey: "fleet-expiry-digest",
    title: "Fleet reminders",
    body: count === 1 ? "A vehicle document needs attention." : `${count} vehicle documents need attention.`,
    url: "/resources?tab=vehicles",
  };
}

export function paymentPush(opts: {
  kind: "deposit" | "balance";
  quoteId: string;
  customerName: string | null;
  leadId: string | null;
}): PushEvent {
  const first = firstNameOnly(opts.customerName);
  return {
    category: "payment_event",
    eventKey: `payment-${opts.kind}-${opts.quoteId}`,
    title: opts.kind === "deposit" ? "Deposit received" : "Balance received",
    body: `${first} has paid their ${opts.kind}.`,
    url: opts.leadId ? `/leads/${opts.leadId}` : "/bookings",
  };
}

/* ---------------------------------------------- bank-feed arrivals (Monzo) */

/** A transaction the 2-min bank-feed sync just surfaced for the office —
 *  either an actionable suggestion (one tap to confirm on /payments) or a
 *  transfer that needs a human (no match / wrong amount). */
export interface BankFeedArrival {
  /** bank_transactions row id — one OS tag per transfer, so a later
   *  "now matched" push REPLACES the earlier "needs matching" one. */
  rowId: string;
  outcome: "suggested" | "attention";
  kind: "deposit" | "commitment" | "balance" | "storage" | null;
  /** Matched customer when known, else the payer name off the statement. */
  name: string | null;
  quoteRef: string | null;
}

export function bankPaymentPush(a: BankFeedArrival): PushEvent {
  const first = firstNameOnly(a.name, "a customer");
  let body: string;
  if (a.outcome === "suggested") {
    body =
      a.kind === "storage"
        ? "A storage payment has arrived — check it on Payments."
        : `Looks like ${first}'s ${a.kind ?? "payment"}${a.quoteRef ? ` (${a.quoteRef})` : ""} — one tap to confirm.`;
  } else {
    body = a.quoteRef
      ? `A payment from ${first} doesn't match what's due on ${a.quoteRef} — needs a look.`
      : `A payment from ${first} needs matching to a job.`;
  }
  return {
    category: "payment_event",
    eventKey: `bank-tx-${a.rowId}`,
    title: "Bank payment in",
    body,
    url: "/payments",
  };
}

export function bankPaymentDigestPush(count: number): PushEvent {
  return {
    category: "payment_event",
    eventKey: "bank-feed-digest",
    title: "Bank payments in",
    body: `${count} bank payments arrived and need checking.`,
    url: "/payments",
  };
}

/** Storm guard, same shape as the enquiry one: a burst (a re-pointed sheet,
 *  a busy Friday) collapses into one digest instead of a phone full of pings. */
export const BANK_FEED_DIGEST_THRESHOLD = 3;

export function decideBankFeedPushes(
  arrivals: readonly BankFeedArrival[],
  /** Suggested+unmatched rows pending at push time: the constant digest tag
   *  REPLACES any earlier digest on the phone, so it must show the fuller
   *  number — never just the latest pass's arrivals. */
  totalPending = 0,
): PushEvent[] {
  if (arrivals.length === 0) return [];
  if (arrivals.length > BANK_FEED_DIGEST_THRESHOLD)
    return [bankPaymentDigestPush(Math.max(arrivals.length, totalPending))];
  return arrivals.map(bankPaymentPush);
}

/** "Sat 19 Jul" in UK time from an ISO timestamp — the only job detail safe
 *  on a lock screen (no names, addresses or times; /my-jobs has the rest). */
export function ukJobDayLabel(startsAt: string | null | undefined): string | null {
  if (!startsAt) return null;
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
}

export function crewJobPush(opts: {
  kind: "assigned" | "removed";
  appointmentId: string;
  staffUserId: string;
  startsAt: string | null;
}): PushEvent {
  const day = ukJobDayLabel(opts.startsAt);
  return {
    category: "crew_job",
    // One tag per (job, person): a removal REPLACES the assignment
    // notification still sitting on the phone, so stale "you're on this job"
    // alerts can't outlive a change of plan.
    eventKey: `crew-job-${opts.appointmentId}-${opts.staffUserId}`,
    title: opts.kind === "assigned" ? "New job for you" : "Job change",
    body:
      opts.kind === "assigned"
        ? day
          ? `You've been put on a job on ${day}.`
          : "You've been put on a job."
        : day
          ? `You've been taken off the job on ${day}.`
          : "You've been taken off a job.",
    // A removed crew member no longer passes the job page's assignment gate —
    // send them to their list instead.
    url: opts.kind === "assigned" ? `/my-jobs/${opts.appointmentId}` : "/my-jobs",
  };
}

/** The estimator's own survey ping. Lock-screen safe: first name only, never
 *  the customer's address or phone (both live in the email + the panel). */
export function surveyAssignedPush(opts: {
  kind: "booked" | "moved" | "removed" | "cancelled";
  appointmentId: string;
  customerName: string | null;
  startsAt: string | null;
  leadId: string | null;
}): PushEvent {
  const day = ukJobDayLabel(opts.startsAt);
  const who = firstNameOnly(opts.customerName, "A customer");
  const onDay = day ? ` on ${day}` : "";
  let body: string;
  let title: string;
  switch (opts.kind) {
    case "cancelled":
      title = "Survey cancelled";
      body = `${who}'s survey${onDay} is cancelled. Don't travel.`;
      break;
    case "removed":
      title = "Survey reassigned";
      body = `${who}'s survey${onDay} has gone to someone else.`;
      break;
    case "moved":
      title = "Survey moved";
      body = day ? `${who}'s survey has moved to ${day}.` : `${who}'s survey has a new time.`;
      break;
    default:
      title = "New survey for you";
      body = `You're surveying ${who}${onDay}.`;
  }
  return {
    category: "survey_assigned",
    // One tag per (appointment, estimator-facing event stream): a move, a
    // hand-off or a cancellation REPLACES the earlier "you're surveying X"
    // still sitting on the phone, so a stale time can never outlive the change.
    eventKey: `survey-assigned-${opts.appointmentId}`,
    title,
    body,
    // Reassigned or cancelled: the estimator no longer owns the visit, so the
    // lead page's context is the wrong landing — send them to their diary.
    url: opts.kind === "removed" || opts.kind === "cancelled" || !opts.leadId ? "/schedule/surveys" : `/leads/${opts.leadId}`,
  };
}

/**
 * Digest-or-individual decision for a batch of freshly INSERTED web leads.
 * Only leads submitted inside the freshness window push at all — the cutover
 * backfill will insert months of history and must stay silent. 1–3 fresh
 * leads notify individually; more collapse into one digest.
 */
export const ENQUIRY_FRESH_WINDOW_MS = 24 * 3600 * 1000;
export const ENQUIRY_DIGEST_THRESHOLD = 3;

/** Shared freshness rule for both push delivery and the in-app audio alarm. */
export function isFreshEnquiryTimestamp(submittedAt: string | null, now: Date): boolean {
  if (!submittedAt) return false;
  const t = Date.parse(submittedAt);
  return Number.isFinite(t) && now.getTime() - t <= ENQUIRY_FRESH_WINDOW_MS && t <= now.getTime() + 60_000;
}

export function decideEnquiryPushes(
  inserted: readonly { id: string; name: string | null; submittedAt: string | null }[],
  now: Date,
): PushEvent[] {
  const fresh = inserted.filter((l) => isFreshEnquiryTimestamp(l.submittedAt, now));
  if (fresh.length === 0) return [];
  if (fresh.length > ENQUIRY_DIGEST_THRESHOLD) return [newEnquiryDigestPush(fresh.length)];
  return fresh.map((l) => newEnquiryPush(l));
}
