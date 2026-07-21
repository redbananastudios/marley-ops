import Link from "next/link";
import { redirect } from "next/navigation";
import { CircleHelp, HandCoins, History } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { ukDayOf } from "@/lib/sales-report";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import {
  buildRefundQueueView,
  gbpPence,
  type CardStateIn,
  type QueueItemView,
  type QueueRowIn,
  type QuoteRefIn,
  type RailMarkIn,
} from "@/lib/refunds/queue-view";
import { DecisionCard } from "./decision-card";
import { ExecuteCard } from "./execute-card";

/**
 * /refunds — the held-money decision queue (Payments Policy v2, PRD §5D).
 * Rows appear automatically from cancels / inside-window date changes; nothing
 * clears without a button press. Three sections: Needs decision (the one human
 * question), To execute (per-rail payout controls), History.
 *
 * ADMIN-ONLY, gated server-side here AND in every action — nav is never the
 * security boundary (the /finance/statements pattern).
 */

export const dynamic = "force-dynamic";

const QUEUE_COLS =
  "id, created_at, lead_id, quote_id, original_move_date, trigger, held, conditional_amount, unconditional_amount, determination, determined_by, determined_at, status, executed_by, executed_at, shortfall_note, cash_recipient_name, cash_recipient_sort, cash_recipient_account, notes";

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className="tabular mt-1 font-display text-2xl font-bold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </Card>
  );
}

function Section({
  title,
  icon,
  count,
  empty,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-0">
      <div className="flex items-center gap-2 border-b px-5 py-3.5">
        {icon}
        <h2 className="font-display text-lg text-foreground">{title}</h2>
        <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">{count}</span>
      </div>
      {count === 0 ? (
        <p className="px-5 py-6 text-sm text-mist-400">{empty}</p>
      ) : (
        <div className="divide-y divide-mist-150">{children}</div>
      )}
    </Card>
  );
}

function HistoryRow({ item, byName }: { item: QueueItemView; byName: string | null }) {
  const refunded = item.status === "refunded";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        {item.leadId ? (
          <Link href={`/leads/${item.leadId}`} className="font-medium text-foreground hover:underline">
            {item.customer}
          </Link>
        ) : (
          <span className="font-medium text-foreground">{item.customer}</span>
        )}
        <p className="text-xs text-mist-400">
          {item.quoteRef ?? "—"}
          {" · "}
          {item.triggerLabel}
          {item.originalMoveDate ? ` · original date ${whenLabel(item.originalMoveDate + "T12:00:00Z")}` : ""}
        </p>
      </div>
      <span
        className={
          "rounded-full px-2.5 py-0.5 text-[11px] font-semibold " +
          (refunded ? "bg-success/10 text-success" : "bg-mist-100 text-mist-500")
        }
      >
        {refunded ? "Refunded" : "Retained"}
      </span>
      <div className="text-right">
        <p className="tabular text-sm font-semibold text-foreground">
          {refunded ? gbpPence(item.refundDuePence) : gbpPence(item.retainPence)}
          {!refunded && item.refundDuePence > 0 ? (
            <span className="ml-1 font-normal text-mist-400">+ {gbpPence(item.refundDuePence)} refunded</span>
          ) : null}
        </p>
        <p className="text-xs text-mist-400">
          {whenLabel(item.executedAt)}
          {byName ? ` · by ${byName}` : ""}
        </p>
      </div>
    </div>
  );
}

export default async function RefundsPage() {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  // Admin-only: this page decides and moves customer money.
  if (profile.role === "estimator") redirect("/estimator/pay");
  if (profile.role === "crew") redirect("/my-jobs");
  if (profile.role !== "admin") redirect("/");

  const sb = await createClient();
  const rows = await fetchAllRows<QueueRowIn>((from, to) =>
    sb.from("refund_queue").select(QUEUE_COLS).order("created_at", { ascending: false }).range(from, to),
  );

  // Context joins: quote refs/names, actor names, card ground truth, rail marks.
  const quoteIds = [...new Set(rows.map((r) => r.quote_id).filter(Boolean))] as string[];
  const actorIds = [
    ...new Set(rows.flatMap((r) => [r.determined_by, r.executed_by]).filter(Boolean)),
  ] as string[];
  const cardIds = [
    ...new Set(
      rows.flatMap((r) => (Array.isArray(r.held) ? r.held : []))
        .map((h) => (h && typeof h === "object" ? (h as { card_payment_id?: unknown }).card_payment_id : null))
        .filter((v): v is string => typeof v === "string"),
    ),
  ];
  const pendingIds = rows.filter((r) => r.status === "pending").map((r) => r.id);

  const [{ data: quotes }, { data: actors }, { data: cardRows }, { data: markRows }] =
    await Promise.all([
      quoteIds.length
        ? sb.from("quotes").select("id, quote_ref, customer_name, lead_id").in("id", quoteIds)
        : Promise.resolve({ data: [] as { id: string; quote_ref: string; customer_name: string | null; lead_id: string | null }[] }),
      actorIds.length
        ? sb.from("profiles").select("id, full_name").in("id", actorIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
      cardIds.length
        ? sb.from("card_payments").select("id, status, amount_pence, refunded_pence").in("id", cardIds)
        : Promise.resolve({ data: [] as CardStateIn[] }),
      pendingIds.length
        ? sb
            .from("events_log")
            .select("entity_id, diff")
            .eq("entity_type", "refund_queue")
            .eq("action", "rail_refunded")
            .in("entity_id", pendingIds)
        : Promise.resolve({ data: [] as { entity_id: string | null; diff: unknown }[] }),
    ]);

  const quotesById = new Map<string, QuoteRefIn>(
    (quotes ?? []).map((q) => [q.id, { quote_ref: q.quote_ref, customer_name: q.customer_name, lead_id: q.lead_id }]),
  );
  const nameById = new Map((actors ?? []).map((p) => [p.id, p.full_name]));
  const cardStatesById = new Map<string, CardStateIn>((cardRows ?? []).map((c) => [c.id, c]));
  const railMarks: RailMarkIn[] = (markRows ?? [])
    .map((m) => {
      const diff = (m.diff ?? {}) as { rail?: unknown; amount_pence?: unknown };
      return {
        queueId: m.entity_id ?? "",
        rail: typeof diff.rail === "string" ? diff.rail : "",
        amountPence: Number(diff.amount_pence) || 0,
      };
    })
    .filter((m) => m.queueId && m.rail);

  const view = buildRefundQueueView({
    rows,
    quotesById,
    cardStatesById,
    railMarks,
    todayUkDay: ukDayOf(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10),
  });

  return (
    <main className="flex-1 space-y-5 p-6 md:p-8">
      <PageHeader eyebrow="Finance" title="Refunds" />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Needs decision"
          value={String(view.totals.needsDecisionCount)}
          sub="waiting on the re-book question"
        />
        <Stat
          label="To pay out"
          value={gbpPence(view.totals.outstandingPence)}
          sub={`across ${view.totals.toExecuteCount} ${view.totals.toExecuteCount === 1 ? "entry" : "entries"}`}
        />
        <Stat
          label="Held on open entries"
          value={gbpPence(view.totals.heldPendingPence)}
          sub={`${view.totals.pendingCount} open ${view.totals.pendingCount === 1 ? "entry" : "entries"}`}
        />
      </div>

      <Section
        title="Needs decision"
        icon={<CircleHelp className="size-4 text-mist-400" strokeWidth={1.75} />}
        count={view.needsDecision.length}
        empty="Nothing is waiting on the re-book question."
      >
        {view.needsDecision.map((item) => (
          <DecisionCard key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="To execute"
        icon={<HandCoins className="size-4 text-mist-400" strokeWidth={1.75} />}
        count={view.toExecute.length}
        empty="No refunds are waiting to be paid out."
      >
        {view.toExecute.map((item) => (
          <ExecuteCard key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="History"
        icon={<History className="size-4 text-mist-400" strokeWidth={1.75} />}
        count={view.history.length}
        empty="No refunds have been settled yet."
      >
        {view.history.map((item) => (
          <HistoryRow key={item.id} item={item} byName={item.executedBy ? (nameById.get(item.executedBy) ?? null) : null} />
        ))}
      </Section>
    </main>
  );
}
