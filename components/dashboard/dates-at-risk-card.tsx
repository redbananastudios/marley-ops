/**
 * "Dates at risk" — dashboard needs-action card (Payments Policy v2, PRD §5B).
 *
 * A booking lands here when its commitment invoice is still unpaid at 7 days
 * before the move (the chase cron stamps quotes.date_releasable_at). This is a
 * DISCRETION state: nothing is released automatically — releasing a date is a
 * manual cancel with the standard customer-cancel treatment.
 *
 * Purely presentational and hook-free so it mounts in a server page or inside
 * a client tree. NOT mounted here by design — integration mounts it (see the
 * mount notes at the bottom of this file).
 */

import Link from "next/link";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";

export interface DateAtRiskItem {
  leadId: string;
  quoteRef: string;
  customerName: string | null;
  /** quotes.moving_date (yyyy-mm-dd). */
  movingDate: string | null;
  /** Unpaid commitment amount — VAT-inclusive gross. */
  amountDue: number;
  /** quotes.date_releasable_at — when the T-7 flag landed. */
  releasableSince: string | null;
}

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "Mon 17 Aug" from a stored yyyy-mm-dd (UTC-midnight parse is DST-safe for
 *  bare dates; rendered on Europe/London). */
function dayLabel(day: string | null): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "—";
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  });
}

/**
 * Renders nothing when there are no at-risk dates — this card is an alarm, not
 * a status tile, so an empty state would only add dashboard noise.
 */
export function DatesAtRiskCard({ items }: { items: DateAtRiskItem[] }) {
  if (items.length === 0) return null;
  return (
    <Card className="gap-0 overflow-hidden border-t-2 border-t-mm-red p-0">
      <div className="flex items-start justify-between gap-2 px-5 pt-5">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0 text-mm-red" strokeWidth={2} />
          <p className="eyebrow">Dates at risk</p>
        </div>
        <p className="font-display tabular text-2xl font-bold text-mm-red">{items.length}</p>
      </div>
      <p className="px-5 pt-1 text-xs text-mist-400">
        Commitment unpaid at 7 days out. Nothing releases automatically — call the customer, or
        release the day via a manual cancel.
      </p>
      <ul className="mt-3 divide-y border-t">
        {items.map((r) => (
          <li key={`${r.leadId}-${r.quoteRef}`}>
            <Link
              href={`/leads/${r.leadId}`}
              className="focus-ring flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  {r.customerName ?? "—"}
                  <span className="ml-2 font-normal text-mist-400">{r.quoteRef}</span>
                </p>
                <p className="truncate text-xs text-mist-400">
                  Move {dayLabel(r.movingDate)} · flagged {dayLabel(r.releasableSince ? r.releasableSince.slice(0, 10) : null)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="tabular text-sm font-semibold text-mm-red">{gbp(r.amountDue)}</span>
                <ChevronRight className="size-4 text-mist-300" strokeWidth={1.75} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------- mount notes
 *
 * Integration mounts this on the dashboard (app/(dashboard)/page.tsx), in the
 * "Needs action now" section area — e.g. directly below the ActionCard grid,
 * or above it as a full-width alarm strip. Two-step wiring:
 *
 * 1. Load the rows in the server page (join the accepted quote's flag with the
 *    lead's live status so cancelled/completed jobs drop out):
 *
 *    const ukToday = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
 *    const { data: riskQuotes } = await supabase
 *      .from("quotes")
 *      .select("lead_id, quote_ref, customer_name, moving_date, commitment_invoice_amount, date_releasable_at")
 *      .eq("status", "accepted")
 *      .not("date_releasable_at", "is", null)
 *      .is("commitment_paid_at", null)
 *      .gte("moving_date", ukToday)
 *      .order("moving_date", { ascending: true });
 *    const riskLeadIds = [...new Set((riskQuotes ?? []).map((q) => q.lead_id).filter(Boolean))] as string[];
 *    const { data: riskLeads } = riskLeadIds.length
 *      ? await supabase.from("leads").select("id, name, status").in("id", riskLeadIds).eq("status", "confirmed")
 *      : { data: [] };
 *    const riskLeadById = new Map((riskLeads ?? []).map((l) => [l.id, l]));
 *    const datesAtRisk: DateAtRiskItem[] = (riskQuotes ?? [])
 *      .filter((q) => q.lead_id && riskLeadById.has(q.lead_id))
 *      .map((q) => ({
 *        leadId: q.lead_id!,
 *        quoteRef: q.quote_ref,
 *        customerName: q.customer_name ?? riskLeadById.get(q.lead_id!)?.name ?? null,
 *        movingDate: q.moving_date,
 *        amountDue: Number(q.commitment_invoice_amount ?? 0),
 *        releasableSince: q.date_releasable_at,
 *      }));
 *
 * 2. Render <DatesAtRiskCard items={datesAtRisk} /> — either directly in the
 *    server page next to <DashboardView …/>, or thread the items through
 *    DashboardData and mount inside the client view (the component is
 *    hook-free, so both work). It renders null when items is empty.
 */
