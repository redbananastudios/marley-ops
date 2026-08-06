import Link from "next/link";
import { Banknote, ChevronLeft, ChevronRight, CreditCard, Landmark } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  buildReceivedDay,
  ukDayWindow,
  type QuoteIn,
  type ReceivedItem,
} from "@/lib/payments/received";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { bankFeedConfigured } from "@/lib/bank-feed/sync";
import { isAcquirerSettlement } from "@/lib/bank-feed/parse";
import { BankFeedSection, type BankFeedTx } from "@/components/payments/bank-feed-section";
import { RefreshButton } from "@/components/payments/refresh-button";

/**
 * Payments — everything that landed on a given UK day, newest first.
 * Card receipts/refunds come from the takepayments ledger; deposits and
 * balances marked paid in the panel (BACS one-tap, cash) show as "recorded".
 * The bank-feed section is the seam for the Revolut/Monzo integration —
 * inbound transfers matched by reference will list there automatically.
 */

export const dynamic = "force-dynamic";

const QUOTE_COLS =
  "id, quote_ref, lead_id, customer_name, agreed_price, grand_total, deposit_amount, deposit_paid_at, balance_invoice_amount, commitment_invoice_amount";

function money(pence: number): string {
  const s = (Math.abs(pence) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${pence < 0 ? "−" : ""}£${s}`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

/** "3 min ago" health line for the bank-feed sync (module-level so the render
 *  stays pure per the react-hooks lint). */
function syncAgeLabel(finishedAt: string | null | undefined, ok: boolean): string | null {
  if (!finishedAt) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(finishedAt).getTime()) / 60000));
  return `${mins} min ago${ok ? "" : " · last run FAILED"}`;
}

function dayLabel(day: string, isToday: boolean): string {
  if (isToday) return "Today";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

const CARD_BADGE: Record<string, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-success/10 text-success" },
  partially_refunded: { label: "Part-refunded", cls: "bg-mist-100 text-mist-500" },
  refunded: { label: "Refunded", cls: "bg-mist-100 text-mist-500" },
  voided: { label: "Voided", cls: "bg-mist-100 text-mist-500" },
  needs_review: { label: "Needs review", cls: "bg-warn-bg text-warn" },
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className="tabular mt-1 font-display text-2xl font-bold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
    </Card>
  );
}

function ItemRow({ item }: { item: ReceivedItem }) {
  const badge = item.cardStatus ? CARD_BADGE[item.cardStatus] : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <span className="tabular w-12 shrink-0 text-xs text-mist-400">{timeOf(item.at)}</span>
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
          <span className="capitalize">{item.kind}</span>
          {item.cardMask ? ` · ${item.cardScheme ? `${item.cardScheme} ` : ""}•••• ${item.cardMask.slice(-4)}` : null}
          {item.note ? ` · ${item.note}` : null}
        </p>
      </div>
      {item.isTest ? (
        <span className="rounded-pill bg-warn-bg px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-warn">
          Test
        </span>
      ) : null}
      {badge && item.kind !== "refund" ? (
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${badge.cls}`}>{badge.label}</span>
      ) : null}
      <span
        className={
          "tabular text-sm font-semibold " + (item.amountPence < 0 ? "text-warn" : "text-foreground")
        }
      >
        {money(item.amountPence)}
      </span>
    </div>
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

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const window = ukDayWindow(date);
  const startIso = window.start.toISOString();
  const endIso = window.end.toISOString();

  const sb = await createClient();
  const [{ data: cardRows }, { data: depositQuotes }, { data: commitmentQuotes }, { data: balanceLeads }] =
    await Promise.all([
      sb
        .from("card_payments")
        .select(
          "id, kind, status, amount_pence, refunded_pence, is_test, settled_at, refunded_at, refund_reason, quote_id, lead_id, card_number_mask, card_scheme",
        )
        .or(
          `and(settled_at.gte.${startIso},settled_at.lt.${endIso}),and(refunded_at.gte.${startIso},refunded_at.lt.${endIso})`,
        ),
      sb.from("quotes").select(QUOTE_COLS).gte("deposit_paid_at", startIso).lt("deposit_paid_at", endIso),
      sb
        .from("quotes")
        .select(`${QUOTE_COLS}, commitment_paid_at`)
        .gte("commitment_paid_at", startIso)
        .lt("commitment_paid_at", endIso),
      sb
        .from("leads")
        .select("id, name, balance_paid_at, balance_amount")
        .gte("balance_paid_at", startIso)
        .lt("balance_paid_at", endIso),
    ]);

  // Names/refs for card + balance rows come from the lead's accepted quote.
  const leadIds = [
    ...new Set(
      [
        ...(cardRows ?? []).map((r) => r.lead_id),
        ...(balanceLeads ?? []).map((l) => l.id),
      ].filter(Boolean) as string[],
    ),
  ];
  const { data: moneyQuotes } = leadIds.length
    ? await sb
        .from("quotes")
        .select(`${QUOTE_COLS}, accepted_at`)
        .in("lead_id", leadIds)
        .eq("status", "accepted")
        .order("accepted_at", { ascending: false })
    : { data: [] as (QuoteIn & { accepted_at: string | null })[] };
  const quoteByLeadId = new Map<string, QuoteIn>();
  for (const q of moneyQuotes ?? []) {
    if (q.lead_id && !quoteByLeadId.has(q.lead_id)) quoteByLeadId.set(q.lead_id, q);
  }

  const day = buildReceivedDay({
    window,
    cardRows: cardRows ?? [],
    depositQuotes: depositQuotes ?? [],
    commitmentQuotes: commitmentQuotes ?? [],
    balanceLeads: balanceLeads ?? [],
    quoteByLeadId,
  });
  const cardItems = day.items.filter((i) => i.source === "card");
  const recordedItems = day.items.filter((i) => i.source === "recorded");

  // Bank feed (when configured): the viewed day's inbound transfers + the
  // suggestion queue across ALL dates — reconciliation surfaces old transfers
  // that match still-open invoices, so the confirm queue isn't day-scoped.
  let bank: {
    suggested: BankFeedTx[];
    mismatches: BankFeedTx[];
    dayRows: BankFeedTx[];
    unmatched: BankFeedTx[];
    lastSync: string | null;
  } | null = null;
  if (bankFeedConfigured()) {
    const TX_COLS =
      "id, tx_date, tx_time, counterparty, amount, reference, status, match_kind, match_confidence, matched_quote_id";
    const [sugRes, misRes, dayRes, unmatchedRes, syncRes] = await Promise.all([
      sb
        .from("bank_transactions")
        .select(TX_COLS)
        .eq("status", "suggested")
        .order("tx_date", { ascending: false })
        .limit(20),
      // Mismatches: a transfer that NAMES an open quote at the wrong amount
      // (part-payment / duplicate) — unmatched status but with a match_kind.
      sb
        .from("bank_transactions")
        .select(TX_COLS)
        .eq("status", "unmatched")
        .not("matched_quote_id", "is", null)
        .order("tx_date", { ascending: false })
        .limit(10),
      sb
        .from("bank_transactions")
        .select(TX_COLS)
        .eq("tx_date", window.day)
        // Dismissed money is cleared and must disappear from the day feed
        // (it's already off the counts). info rows are fetched but filtered
        // below to JUST acquirer settlements — the payout stays browsable with
        // a "Card settlement" chip while outbound/pot noise stays hidden.
        .neq("status", "dismissed")
        .order("tx_time", { ascending: false }),
      // Plain unmatched inbound across ALL dates — money we don't recognise
      // (old-system transfers, non-customer credits). matched_quote_id is null
      // so this never overlaps the mismatch queue (those NAME a quote). Each
      // row is clearable; surfacing them all-dates is what makes the count and
      // the visible list agree instead of counting prior-day rows the day feed
      // hides.
      sb
        .from("bank_transactions")
        .select(TX_COLS)
        .eq("status", "unmatched")
        .is("matched_quote_id", null)
        .order("tx_date", { ascending: false })
        .limit(50),
      sb
        .from("cron_runs")
        .select("finished_at, status")
        .eq("job", "bank-feed")
        .order("started_at", { ascending: false })
        .limit(1),
    ]);
    const settlementRow = (r: { counterparty?: string | null; reference?: string | null }) =>
      isAcquirerSettlement({ counterparty: r.counterparty ?? null, reference: r.reference ?? null });
    const dayData = (dayRes.data ?? []).filter((r) => r.status !== "info" || settlementRow(r));
    const rows = [...(sugRes.data ?? []), ...(misRes.data ?? []), ...dayData];
    const qIds = [...new Set(rows.map((r) => r.matched_quote_id).filter(Boolean))] as string[];
    const { data: qRows } = qIds.length
      ? await sb
          .from("quotes")
          .select(
            "id, quote_ref, customer_name, lead_id, deposit_amount, deposit_paid_at, balance_invoice_amount, agreed_price, grand_total, commitment_invoice_amount",
          )
          .in("id", qIds)
      : { data: [] };
    const qById = new Map((qRows ?? []).map((q) => [q.id as string, q]));
    const toTx = (r: (typeof rows)[number]): BankFeedTx => {
      const q = r.matched_quote_id ? qById.get(r.matched_quote_id as string) : null;
      const kind = (r.match_kind as string | null) ?? null;
      const expectedAmount = q
        ? kind === "deposit"
          ? Number(q.deposit_amount) || null
          : kind === "commitment"
            ? Number(q.commitment_invoice_amount) || null
            : kind === "balance"
              ? Number(q.balance_invoice_amount) ||
                Math.max(
                  0,
                  Number(q.agreed_price ?? q.grand_total ?? 0) -
                    Number(q.deposit_amount ?? 0) -
                    Number(q.commitment_invoice_amount ?? 0),
                ) ||
                null
              : null
        : null;
      return {
        id: r.id as string,
        txDate: r.tx_date as string,
        txTime: (r.tx_time as string | null) ?? null,
        counterparty: (r.counterparty as string | null) ?? null,
        amount: Number(r.amount),
        reference: (r.reference as string | null) ?? null,
        status: r.status as string,
        matchKind: kind,
        matchConfidence: (r.match_confidence as string | null) ?? null,
        quoteId: (r.matched_quote_id as string | null) ?? null,
        quoteRef: (q?.quote_ref as string | null) ?? null,
        quoteCustomer: (q?.customer_name as string | null) ?? null,
        leadId: (q?.lead_id as string | null) ?? null,
        expectedAmount,
        isSettlement: settlementRow(r),
      };
    };
    const last = syncRes.data?.[0];
    const lastSync = syncAgeLabel(last?.finished_at as string | null, last?.status === "ok");
    bank = {
      suggested: (sugRes.data ?? []).map(toTx),
      mismatches: (misRes.data ?? []).map(toTx),
      dayRows: dayData.map(toTx),
      unmatched: (unmatchedRes.data ?? []).map(toTx),
      lastSync,
    };
  }

  const navBtn =
    "focus-ring inline-flex size-9 items-center justify-center rounded-md border border-input bg-card text-mist-500 hover:bg-muted";

  return (
    <main className="flex-1 space-y-5 p-6 md:p-8">
      <PageHeader eyebrow="Finance" title="Payments">
        <div className="flex items-center gap-2">
          <Link href={`/payments?date=${window.prev}`} aria-label="Previous day" className={navBtn}>
            <ChevronLeft className="size-4" strokeWidth={2} />
          </Link>
          <span className="min-w-36 text-center text-sm font-semibold text-foreground">
            {dayLabel(window.day, window.isToday)}
          </span>
          {window.isToday ? (
            <span aria-hidden className={`${navBtn} pointer-events-none opacity-35`}>
              <ChevronRight className="size-4" strokeWidth={2} />
            </span>
          ) : (
            <Link href={`/payments?date=${window.next}`} aria-label="Next day" className={navBtn}>
              <ChevronRight className="size-4" strokeWidth={2} />
            </Link>
          )}
          {!window.isToday ? (
            <Link href="/payments" className="ml-1 text-sm font-medium text-mm-red hover:underline">
              Today
            </Link>
          ) : null}
          <RefreshButton />
        </div>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Received"
          value={money(day.totalPence)}
          sub={window.isToday ? "so far today" : dayLabel(window.day, false)}
        />
        <Stat label="Card" value={money(day.cardPence)} sub="takepayments, net of refunds" />
        <Stat label="Recorded" value={money(day.recordedPence)} sub="bank transfer / cash, marked paid in the panel" />
      </div>

      <Section
        title="Card payments"
        icon={<CreditCard className="size-4 text-mist-400" strokeWidth={1.75} />}
        count={cardItems.length}
        empty="No card payments on this day."
      >
        {cardItems.map((i) => (
          <ItemRow key={i.key} item={i} />
        ))}
      </Section>

      <Section
        title="Recorded in the panel"
        icon={<Banknote className="size-4 text-mist-400" strokeWidth={1.75} />}
        count={recordedItems.length}
        empty="No deposits or balances were marked paid on this day."
      >
        {recordedItems.map((i) => (
          <ItemRow key={i.key} item={i} />
        ))}
      </Section>

      {bank ? (
        <BankFeedSection
          suggested={bank.suggested}
          mismatches={bank.mismatches}
          dayRows={bank.dayRows}
          unmatched={bank.unmatched}
          dayLabelText={window.isToday ? "so far today" : `on ${dayLabel(window.day, false)}`}
          lastSync={bank.lastSync}
        />
      ) : (
        <Card className="flex items-start gap-3 border-dashed px-5 py-4">
          <Landmark className="mt-0.5 size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
          <div>
            <p className="text-sm font-semibold text-foreground">Bank feed — coming soon</p>
            <p className="mt-0.5 text-sm text-mist-400">
              Once the business bank account is connected, inbound transfers will appear here automatically and
              match to quotes by their payment reference — no more checking the banking app.
            </p>
          </div>
        </Card>
      )}
    </main>
  );
}
