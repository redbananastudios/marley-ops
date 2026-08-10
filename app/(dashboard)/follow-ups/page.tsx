import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { FollowUpsQueue, type FollowUpRow } from "@/components/followups/followups-queue";

export const dynamic = "force-dynamic";

type QuoteContextRow = {
  lead_id: string | null;
  quote_ref: string;
  status: string;
  agreed_price: number | null;
  grand_total: number | null;
  created_at: string;
  moving_date: string | null;
};

/**
 * Best quote context per lead for the chase amount: an accepted quote always wins;
 * otherwise the latest LIVE ('sent') quote by created_at desc. Superseded / rejected /
 * draft quotes are never used, so we can't latch onto a stale value (L5, audit 2026-07-31).
 * Ordering is enforced here (not by DB physical order) so the result is deterministic.
 */
export function pickBestQuoteByLead(
  quotes: QuoteContextRow[],
): Map<string, { ref: string; value: number | null; movingDate: string | null }> {
  const valueOf = (q: QuoteContextRow) =>
    q.agreed_price != null ? Number(q.agreed_price) : q.grand_total != null ? Number(q.grand_total) : null;
  const pick = (q: QuoteContextRow) => ({
    ref: q.quote_ref,
    value: valueOf(q),
    movingDate: q.moving_date ?? null,
  });
  const byNewest = [...quotes].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const out = new Map<string, { ref: string; value: number | null; movingDate: string | null }>();
  const acceptedLeads = new Set<string>();
  for (const q of byNewest) {
    if (!q.lead_id) continue;
    if (q.status === "accepted") {
      if (!acceptedLeads.has(q.lead_id)) out.set(q.lead_id, pick(q));
      acceptedLeads.add(q.lead_id); // first (newest) accepted wins
      continue;
    }
    if (acceptedLeads.has(q.lead_id)) continue; // accepted beats any sent quote
    if (q.status !== "sent") continue; // ignore superseded / rejected / draft
    if (!out.has(q.lead_id)) out.set(q.lead_id, pick(q)); // newest sent
  }
  return out;
}

export default async function FollowUpsPage() {
  const sb = await createClient();

  const [{ data: fus }, { data: profiles }] = await Promise.all([
    sb
      .from("follow_ups")
      .select("id, lead_id, quote_id, reason, source, status, due_at, assigned_to, attempt_count, last_attempt_at, notes, metadata, created_at")
      .eq("status", "open")
      .order("due_at", { ascending: true }),
    sb.from("profiles").select("id, full_name"),
  ]);
  const open = fus ?? [];
  const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));

  const leadIds = [...new Set(open.map((f) => f.lead_id))];
  const [{ data: leads }, { data: quotes }] = await Promise.all([
    leadIds.length
      ? sb
          .from("leads")
          .select("id, name, phone, email, preferred_date, property_size, from_postcode, deposit_amount, balance_amount, deposit_paid_at, balance_paid_at")
          .in("id", leadIds)
      : Promise.resolve({ data: [] }),
    leadIds.length
      ? sb
          .from("quotes")
          .select("id, lead_id, quote_ref, status, agreed_price, grand_total, created_at, moving_date")
          .in("lead_id", leadIds)
      : Promise.resolve({ data: [] }),
  ]);
  const leadOf = new Map((leads ?? []).map((l) => [l.id, l]));
  const quoteOf = pickBestQuoteByLead((quotes ?? []) as QuoteContextRow[]);

  const rows: FollowUpRow[] = open.map((f) => {
    const lead = leadOf.get(f.lead_id);
    const quote = quoteOf.get(f.lead_id) ?? null;
    const meta = (f.metadata ?? {}) as { amount?: number };
    // Amount context per reason: chase amount from the payment fields/metadata,
    // otherwise the quote value.
    const amount =
      f.reason === "deposit"
        ? (lead?.deposit_amount != null ? Number(lead.deposit_amount) : meta.amount ?? null)
        : f.reason === "balance"
          ? (lead?.balance_amount != null ? Number(lead.balance_amount) : meta.amount ?? null)
          : quote?.value ?? null;
    return {
      id: f.id,
      leadId: f.lead_id,
      reason: f.reason,
      source: f.source ?? null,
      dueAt: f.due_at,
      attempts: f.attempt_count ?? 0,
      lastAttemptAt: f.last_attempt_at,
      notes: f.notes,
      assignedName: f.assigned_to ? (nameOf.get(f.assigned_to) ?? null) : null,
      name: lead?.name ?? null,
      phone: lead?.phone ?? null,
      email: lead?.email ?? null,
      // The BOOKED date, not the enquiry's wish. leads.preferred_date is written
      // once at enquiry and never again — booking and rescheduling only touch
      // quotes.moving_date — so a rescheduled job showed its original wish date
      // here AND in the prefilled customer email ("your move on <date>"). Fall
      // back to preferred_date only for pre-quote leads, where it's all we have.
      moveDate: quote?.movingDate ?? lead?.preferred_date ?? null,
      propertySize: lead?.property_size ?? null,
      postcode: lead?.from_postcode ?? null,
      quoteRef: quote?.ref ?? null,
      amount,
    };
  });

  return (
    <main className="flex-1 p-6 md:p-8">
      <PageHeader eyebrow="Pipeline" title="Follow-ups" />
      <FollowUpsQueue rows={rows} />
    </main>
  );
}
