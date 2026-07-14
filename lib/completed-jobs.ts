/**
 * Completed Jobs — the browsable history of finished moves (Peter, 2026-07-14).
 * A completed job = a lead in `completed` status. This module does the pure,
 * testable shaping: it joins the batched enrichment (latest removal appointment,
 * accepted quote, completion certificate, review state) into one row per lead,
 * filters by an optional search term (customer name / quote ref), and orders
 * newest-move-first. The page stays a thin loader; nothing here touches Supabase.
 */

/** Review-ask state for a completed job. */
export type ReviewStatus = "sent" | "pending" | "off";

export interface CompletedLead {
  id: string;
  name: string | null;
  client_id: string | null;
  updated_at: string | null;
  from_postcode: string | null;
  to_postcode: string | null;
  review_requested_at: string | null;
  review_suppressed: boolean | null;
}

/** A removal appointment (already filtered to appt_type='removal', not cancelled). */
export interface CompletedRemovalAppt {
  lead_id: string | null;
  starts_at: string | null;
}

export interface CompletedQuote {
  lead_id: string | null;
  quote_ref: string | null;
  status: string;
  agreed_price: number | null;
  grand_total: number | null;
  accepted_at: string | null;
  created_at: string | null;
}

export interface CompletedCompletion {
  lead_id: string | null;
  exceptions: string | null;
  certificate_path: string | null;
  signed_at: string | null;
}

export interface CompletedJobRow {
  leadId: string;
  clientId: string | null;
  customer: string;
  /** From → to postcode line for the grey subline, when both are known. */
  route: string | null;
  /** ISO of the latest removal appointment; null when the job never had one. */
  moveAt: string | null;
  /** What the list is ordered by: the move date, else the lead's last-touched date. */
  sortAt: string;
  quoteRef: string | null;
  value: number | null;
  certificatePath: string | null;
  review: ReviewStatus;
  /** review_requested_at, so the UI can print "Review sent {date}". */
  reviewAt: string | null;
  hasExceptions: boolean;
}

export interface BuildCompletedJobRowsInput {
  leads: CompletedLead[];
  appointments: CompletedRemovalAppt[];
  quotes: CompletedQuote[];
  completions: CompletedCompletion[];
  /** Already-sanitised search term (customer name / quote ref); empty = no filter. */
  search?: string;
}

const routeOf = (from: string | null, to: string | null): string | null => {
  const f = from?.trim();
  const t = to?.trim();
  if (f && t) return `${f} → ${t}`;
  if (f) return `from ${f}`;
  if (t) return `to ${t}`;
  return null;
};

const reviewStatusOf = (l: CompletedLead): ReviewStatus =>
  l.review_requested_at ? "sent" : l.review_suppressed ? "off" : "pending";

/** Latest removal appointment per lead (max starts_at). */
function latestMoveByLead(appointments: CompletedRemovalAppt[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of appointments) {
    if (!a.lead_id || !a.starts_at) continue;
    const cur = m.get(a.lead_id);
    if (!cur || a.starts_at > cur) m.set(a.lead_id, a.starts_at);
  }
  return m;
}

/** One quote per lead: the accepted one wins; ties break to the latest created. */
function bestQuoteByLead(quotes: CompletedQuote[]): Map<string, CompletedQuote> {
  const m = new Map<string, CompletedQuote>();
  for (const q of quotes) {
    if (!q.lead_id) continue;
    const cur = m.get(q.lead_id);
    if (!cur) {
      m.set(q.lead_id, q);
      continue;
    }
    const better =
      (q.status === "accepted" && cur.status !== "accepted") ||
      ((q.status === "accepted") === (cur.status === "accepted") &&
        (q.created_at ?? "") > (cur.created_at ?? ""));
    if (better) m.set(q.lead_id, q);
  }
  return m;
}

/** One completion per lead: prefer one with a certificate, else the latest signed. */
function completionByLead(completions: CompletedCompletion[]): Map<string, CompletedCompletion> {
  const m = new Map<string, CompletedCompletion>();
  for (const c of completions) {
    if (!c.lead_id) continue;
    const cur = m.get(c.lead_id);
    if (!cur) {
      m.set(c.lead_id, c);
      continue;
    }
    const better =
      (!!c.certificate_path && !cur.certificate_path) ||
      ((!!c.certificate_path === !!cur.certificate_path) &&
        (c.signed_at ?? "") > (cur.signed_at ?? ""));
    if (better) m.set(c.lead_id, c);
  }
  return m;
}

export function buildCompletedJobRows({
  leads,
  appointments,
  quotes,
  completions,
  search = "",
}: BuildCompletedJobRowsInput): CompletedJobRow[] {
  const moveByLead = latestMoveByLead(appointments);
  const quoteByLead = bestQuoteByLead(quotes);
  const completionByLeadId = completionByLead(completions);

  const rows: CompletedJobRow[] = leads.map((l) => {
    const q = quoteByLead.get(l.id) ?? null;
    const c = completionByLeadId.get(l.id) ?? null;
    const moveAt = moveByLead.get(l.id) ?? null;
    return {
      leadId: l.id,
      clientId: l.client_id,
      customer: l.name?.trim() || "Customer",
      route: routeOf(l.from_postcode, l.to_postcode),
      moveAt,
      sortAt: moveAt ?? l.updated_at ?? "",
      quoteRef: q?.quote_ref ?? null,
      value: q ? Number(q.agreed_price ?? q.grand_total ?? 0) : null,
      certificatePath: c?.certificate_path ?? null,
      review: reviewStatusOf(l),
      reviewAt: l.review_requested_at,
      hasExceptions: !!c?.exceptions?.trim(),
    };
  });

  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter(
        (r) =>
          r.customer.toLowerCase().includes(term) ||
          (r.quoteRef ?? "").toLowerCase().includes(term),
      )
    : rows;

  // Newest move first; when two share a move date (or neither has one) the name
  // keeps the order stable rather than leaving it to insert order.
  return filtered.sort((a, b) =>
    a.sortAt === b.sortAt ? a.customer.localeCompare(b.customer) : a.sortAt < b.sortAt ? 1 : -1,
  );
}
