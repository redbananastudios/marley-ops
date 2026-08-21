/**
 * The date a quote's status word is actually describing.
 *
 * The /clients/[id] Quotes card labels each row "<status> · <date>", and the
 * date was always `created_at` — so "Accepted · 21 Aug" meant CREATED 21 Aug,
 * whatever day the customer accepted (QA-20260821-02). The status word and the
 * date must describe the same event: accepted → accepted_at, rejected →
 * declined_at (the column rejectQuote stamps), sent → email_sent_at.
 *
 * A draft has no event beyond its creation, and a superseded quote records no
 * supersede time (retiring happens by status flip alone — see supersede.ts), so
 * those fall back to `created_at`; superseded prefers its send date, the last
 * event the row does record. Missing timestamps also fall back to `created_at`
 * rather than showing nothing — an old row stamped before a column existed
 * still deserves a date.
 */

export interface QuoteStatusDates {
  status: string | null;
  created_at: string | null;
  email_sent_at?: string | null;
  accepted_at?: string | null;
  declined_at?: string | null;
}

export function quoteStatusDate(q: QuoteStatusDates): string | null {
  switch (q.status) {
    case "accepted":
      return q.accepted_at ?? q.created_at;
    case "rejected":
      return q.declined_at ?? q.created_at;
    case "sent":
      return q.email_sent_at ?? q.created_at;
    case "superseded":
      return q.email_sent_at ?? q.created_at;
    default:
      return q.created_at;
  }
}
