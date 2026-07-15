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
  // Title-case so "freddy" reads as "Freddy" on a lock screen.
  return first.charAt(0).toUpperCase() + first.slice(1);
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

/**
 * Digest-or-individual decision for a batch of freshly INSERTED web leads.
 * Only leads submitted inside the freshness window push at all — the cutover
 * backfill will insert months of history and must stay silent. 1–3 fresh
 * leads notify individually; more collapse into one digest.
 */
export const ENQUIRY_FRESH_WINDOW_MS = 24 * 3600 * 1000;
export const ENQUIRY_DIGEST_THRESHOLD = 3;

export function decideEnquiryPushes(
  inserted: readonly { id: string; name: string | null; submittedAt: string | null }[],
  now: Date,
): PushEvent[] {
  const fresh = inserted.filter((l) => {
    if (!l.submittedAt) return false;
    const t = Date.parse(l.submittedAt);
    return Number.isFinite(t) && now.getTime() - t <= ENQUIRY_FRESH_WINDOW_MS && t <= now.getTime() + 60_000;
  });
  if (fresh.length === 0) return [];
  if (fresh.length > ENQUIRY_DIGEST_THRESHOLD) return [newEnquiryDigestPush(fresh.length)];
  return fresh.map((l) => newEnquiryPush(l));
}
