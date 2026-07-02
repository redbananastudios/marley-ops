import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { FollowUpsQueue, type FollowUpRow } from "@/components/followups/followups-queue";

export const dynamic = "force-dynamic";

export default async function FollowUpsPage() {
  const sb = await createClient();

  const [{ data: fus }, { data: profiles }] = await Promise.all([
    sb
      .from("follow_ups")
      .select("id, lead_id, quote_id, reason, status, due_at, assigned_to, attempt_count, last_attempt_at, notes, metadata, created_at")
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
          .select("id, lead_id, quote_ref, status, agreed_price, grand_total")
          .in("lead_id", leadIds)
      : Promise.resolve({ data: [] }),
  ]);
  const leadOf = new Map((leads ?? []).map((l) => [l.id, l]));
  // Best quote context per lead: accepted first, else the latest by ref.
  const quoteOf = new Map<string, { ref: string; value: number | null }>();
  for (const q of quotes ?? []) {
    if (!q.lead_id) continue;
    const cur = quoteOf.get(q.lead_id);
    const value = q.agreed_price != null ? Number(q.agreed_price) : q.grand_total != null ? Number(q.grand_total) : null;
    if (!cur || q.status === "accepted") quoteOf.set(q.lead_id, { ref: q.quote_ref, value });
  }

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
      dueAt: f.due_at,
      attempts: f.attempt_count ?? 0,
      lastAttemptAt: f.last_attempt_at,
      notes: f.notes,
      assignedName: f.assigned_to ? (nameOf.get(f.assigned_to) ?? null) : null,
      name: lead?.name ?? null,
      phone: lead?.phone ?? null,
      email: lead?.email ?? null,
      moveDate: lead?.preferred_date ?? null,
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
