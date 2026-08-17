import Link from "next/link";
import { Banknote, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import {
  buildReceivedDay,
  tallyReceived,
  ukRangeWindow,
  type BankMatchIn,
  type LeadIn,
  type QuoteIn,
  type RangePreset,
  type ReceivedItem,
  type UkRangeWindow,
} from "@/lib/payments/received";
import { ukParts } from "@/lib/uk-time";
import { Card } from "@/components/ui/card";
import { bankFeedConfigured, loadLedgerItems } from "@/lib/bank-feed/sync";
import { suggestSettledLink, type SettledItem } from "@/lib/bank-feed/match";
import { isAcquirerSettlement } from "@/lib/bank-feed/parse";
import { BankFeedSection, type BankFeedTx } from "@/components/payments/bank-feed-section";
import { dayHeading, money, timeOf, ukDayOf } from "./format";

/**
 * Received — everything that landed in the selected UK date range, newest
 * first, grouped by day. Card receipts/refunds come from the takepayments
 * ledger; deposits, commitments and balances marked paid in the panel (BACS
 * one-tap, cash, bank-feed confirm) show as recorded, each carrying its rail.
 * Weeks run Monday–Sunday and the current week is the default view (Peter,
 * 2026-08-16). A search sweeps ALL history unless a range was chosen
 * explicitly — finding a payment shouldn't require guessing its week first.
 */

const QUOTE_COLS =
  "id, quote_ref, lead_id, customer_name, agreed_price, grand_total, deposit_amount, deposit_paid_at, deposit_paid_method, balance_invoice_amount, commitment_invoice_amount";

const PAGE_SIZE = 50;

export interface ReceivedParams {
  range?: string;
  from?: string;
  to?: string;
  q?: string;
  page?: string;
  /** Legacy single-day deep links (?date=) keep working as a custom range. */
  date?: string;
}

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: "this-week", label: "This week" },
  { key: "today", label: "Today" },
  { key: "last-week", label: "Last week" },
  { key: "this-month", label: "This month" },
];

function tabHref(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `/payments?${s}` : "/payments";
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

const CARD_BADGE: Record<string, { label: string; cls: string }> = {
  partially_refunded: { label: "Part-refunded", cls: "bg-mist-100 text-mist-500" },
  refunded: { label: "Refunded", cls: "bg-mist-100 text-mist-500" },
  voided: { label: "Voided", cls: "bg-mist-100 text-mist-500" },
  needs_review: { label: "Needs review", cls: "bg-warn-bg text-warn" },
};

const METHOD_CHIP: Record<string, { label: string; cls: string }> = {
  card: { label: "Card", cls: "bg-mm-red/10 text-mm-red" },
  bank_transfer: { label: "Bank transfer", cls: "bg-info-bg text-info" },
  cash: { label: "Cash", cls: "bg-success-bg text-success" },
};

function ItemRow({ item }: { item: ReceivedItem }) {
  const badge = item.cardStatus ? CARD_BADGE[item.cardStatus] : null;
  const method = item.method
    ? METHOD_CHIP[item.method]
    : { label: "Method not recorded", cls: "bg-mist-100 text-mist-400" };
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
      <span className={`rounded-pill px-2.5 py-0.5 text-[11px] font-semibold ${method.cls}`}>{method.label}</span>
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

/** "3 min ago" health line for the bank-feed sync. */
function syncAgeLabel(finishedAt: string | null | undefined, ok: boolean): string | null {
  if (!finishedAt) return null;
  const mins = Math.max(0, Math.round((Date.now() - new Date(finishedAt).getTime()) / 60000));
  return `${mins} min ago${ok ? "" : " · last run FAILED"}`;
}

export async function ReceivedTab({ params }: { params: ReceivedParams }) {
  // Explicit range beats everything; a bare search sweeps all history; the
  // legacy ?date= deep link is a single-day custom range.
  const q = (params.q ?? "").trim();
  const window: UkRangeWindow = params.range
    ? ukRangeWindow({ preset: params.range, from: params.from, to: params.to })
    : params.date
      ? ukRangeWindow({ preset: "custom", from: params.date, to: params.date })
      : q
        ? ukRangeWindow({ preset: "all" })
        : ukRangeWindow();
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
        .select(`${QUOTE_COLS}, commitment_paid_at, commitment_paid_method`)
        .gte("commitment_paid_at", startIso)
        .lt("commitment_paid_at", endIso),
      sb
        .from("leads")
        .select("id, name, balance_paid_at, balance_amount, balance_paid_method")
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
  for (const quote of moneyQuotes ?? []) {
    if (quote.lead_id && !quoteByLeadId.has(quote.lead_id)) quoteByLeadId.set(quote.lead_id, quote);
  }

  // Arrival-day truth: confirmed/reconciled bank matches either arriving in
  // this range (they emit items dated by the bank day) or belonging to a
  // stamp-window quote (they suppress the late stamp item wherever the bank
  // day falls). Without the feed configured the stamps stand alone, as before.
  const bankMatches: BankMatchIn[] = [];
  const bankQuoteById = new Map<string, QuoteIn>();
  const bankLeadById = new Map<string, LeadIn>();
  let unattributedPence = 0;
  if (bankFeedConfigured()) {
    const stampQuoteIds = [
      ...new Set([
        ...(depositQuotes ?? []).map((quote) => quote.id as string),
        ...(commitmentQuotes ?? []).map((quote) => quote.id as string),
        ...[...quoteByLeadId.values()].map((quote) => quote.id),
      ]),
    ];
    const M_COLS = "matched_quote_id, match_kind, tx_date, tx_time";
    const matchRows: { matched_quote_id: string | null; match_kind: string | null; tx_date: string; tx_time: string | null }[] = [];
    const [inRangeRes, unattributedRes] = await Promise.all([
      sb
        .from("bank_transactions")
        .select(M_COLS)
        .in("status", ["confirmed", "reconciled"])
        .in("match_kind", ["deposit", "commitment", "balance"])
        .not("matched_quote_id", "is", null)
        .gte("tx_date", window.startDay)
        .lte("tx_date", window.endDay),
      // The honesty line: inbound money in this range still sitting in the
      // queues — the header can't claim to reconcile to the bank without it.
      sb
        .from("bank_transactions")
        .select("amount")
        .in("status", ["unmatched", "suggested"])
        .gte("tx_date", window.startDay)
        .lte("tx_date", window.endDay),
    ]);
    matchRows.push(...(inRangeRes.data ?? []));
    unattributedPence = (unattributedRes.data ?? []).reduce(
      (s, r) => s + Math.round(Number(r.amount) * 100),
      0,
    );
    for (let i = 0; i < stampQuoteIds.length; i += 100) {
      const { data } = await sb
        .from("bank_transactions")
        .select(M_COLS)
        .in("status", ["confirmed", "reconciled"])
        .in("match_kind", ["deposit", "commitment", "balance"])
        .in("matched_quote_id", stampQuoteIds.slice(i, i + 100));
      matchRows.push(...(data ?? []));
    }
    const seenQk = new Set<string>();
    for (const r of matchRows) {
      if (!r.matched_quote_id || !r.match_kind) continue;
      const qk = `${r.matched_quote_id}:${r.match_kind}`;
      if (seenQk.has(qk)) continue;
      seenQk.add(qk);
      bankMatches.push({
        quoteId: r.matched_quote_id,
        kind: r.match_kind as BankMatchIn["kind"],
        txDate: r.tx_date,
        txTime: r.tx_time,
      });
    }
    const matchQuoteIds = [...new Set(bankMatches.map((m) => m.quoteId))];
    if (matchQuoteIds.length) {
      const { data: mq } = await sb
        .from("quotes")
        .select(`${QUOTE_COLS}, commitment_paid_at, commitment_paid_method`)
        .in("id", matchQuoteIds);
      for (const quote of mq ?? []) bankQuoteById.set(quote.id as string, quote);
      const mLeadIds = [...new Set((mq ?? []).map((quote) => quote.lead_id).filter(Boolean))] as string[];
      if (mLeadIds.length) {
        const { data: ml } = await sb
          .from("leads")
          .select("id, name, balance_paid_at, balance_amount, balance_paid_method")
          .in("id", mLeadIds);
        for (const l of ml ?? []) bankLeadById.set(l.id as string, l);
      }
    }
  }

  const assembled = buildReceivedDay({
    window,
    cardRows: cardRows ?? [],
    depositQuotes: depositQuotes ?? [],
    commitmentQuotes: commitmentQuotes ?? [],
    balanceLeads: balanceLeads ?? [],
    quoteByLeadId,
    bankMatches,
    bankQuoteById,
    bankLeadById,
  });

  const term = q.toLowerCase();
  const matched = term
    ? assembled.items.filter(
        (i) => i.customer.toLowerCase().includes(term) || (i.quoteRef ?? "").toLowerCase().includes(term),
      )
    : assembled.items;
  const totals = term ? tallyReceived(matched) : assembled;

  // Paging keeps long ranges browsable; day groups are built from the slice.
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const pageCount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const pageItems = matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const p = ukParts();
  const todayDay = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const dayGroups: { day: string; items: ReceivedItem[]; totalPence: number }[] = [];
  for (const item of pageItems) {
    const day = ukDayOf(item.at);
    const group = dayGroups.at(-1)?.day === day ? dayGroups.at(-1)! : null;
    if (group) group.items.push(item);
    else dayGroups.push({ day, items: [item], totalPence: 0 });
  }
  for (const group of dayGroups)
    group.totalPence = group.items.filter((i) => !i.isTest).reduce((s, i) => s + i.amountPence, 0);

  const pageHref = (over: Partial<Record<string, string>>): string =>
    tabHref({
      range: params.range,
      from: params.from,
      to: params.to,
      q: q || undefined,
      ...over,
    });

  // Bank feed (when configured): the range's inbound transfers + the
  // suggestion queues across ALL dates — reconciliation surfaces old
  // transfers that match still-open invoices, so those aren't range-scoped.
  let bank: {
    suggested: BankFeedTx[];
    mismatches: BankFeedTx[];
    feedRows: BankFeedTx[];
    unmatched: BankFeedTx[];
    lastSync: string | null;
  } | null = null;
  if (bankFeedConfigured()) {
    const TX_COLS =
      "id, tx_date, tx_time, counterparty, amount, reference, description, status, match_kind, match_confidence, matched_quote_id";
    const [sugRes, misRes, feedRes, unmatchedRes, syncRes] = await Promise.all([
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
        .gte("tx_date", window.startDay)
        .lte("tx_date", window.endDay)
        // Dismissed money is cleared and must disappear from the feed (it's
        // already off the counts). info rows are fetched but filtered below to
        // JUST acquirer settlements — the payout stays browsable with a "Card
        // settlement" chip while outbound/pot noise stays hidden.
        .neq("status", "dismissed")
        .order("tx_date", { ascending: false })
        .order("tx_time", { ascending: false })
        .limit(60),
      // Plain unmatched inbound across ALL dates — money we don't recognise
      // (old-system transfers, non-customer credits). matched_quote_id is null
      // so this never overlaps the mismatch queue (those NAME a quote).
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

    // "Already recorded" hints for the unmatched queue: exact pennies + the
    // payer/reference name corroborating exactly ONE settled item (Dingley's
    // £1,100 "DINGLEY" while Emma Dingley's balance is on the books). Display
    // layer only — auto-reconcile stays reference-only; the office taps Link.
    const unmatchedRows = unmatchedRes.data ?? [];
    const hintByTxId = new Map<string, SettledItem>();
    if (unmatchedRows.length) {
      const { settled } = await loadLedgerItems(sb);
      for (const r of unmatchedRows) {
        const hint = suggestSettledLink(
          {
            amount: Number(r.amount),
            reference: (r.reference as string | null) ?? null,
            description: (r.description as string | null) ?? null,
            counterparty: (r.counterparty as string | null) ?? null,
          },
          settled,
        );
        if (hint) hintByTxId.set(r.id as string, hint);
      }
    }
    const feedData = (feedRes.data ?? []).filter((r) => r.status !== "info" || settlementRow(r));
    const rows = [...(sugRes.data ?? []), ...(misRes.data ?? []), ...feedData];
    const qIds = [...new Set(rows.map((r) => r.matched_quote_id).filter(Boolean))] as string[];
    const { data: qRows } = qIds.length
      ? await sb
          .from("quotes")
          .select(
            "id, quote_ref, customer_name, lead_id, deposit_amount, deposit_paid_at, balance_invoice_amount, agreed_price, grand_total, commitment_invoice_amount",
          )
          .in("id", qIds)
      : { data: [] };
    const qById = new Map((qRows ?? []).map((quote) => [quote.id as string, quote]));
    const toTx = (r: (typeof rows)[number]): BankFeedTx => {
      const quote = r.matched_quote_id ? qById.get(r.matched_quote_id as string) : null;
      const kind = (r.match_kind as string | null) ?? null;
      const expectedAmount = quote
        ? kind === "deposit"
          ? Number(quote.deposit_amount) || null
          : kind === "commitment"
            ? Number(quote.commitment_invoice_amount) || null
            : kind === "balance"
              ? Number(quote.balance_invoice_amount) ||
                Math.max(
                  0,
                  Number(quote.agreed_price ?? quote.grand_total ?? 0) -
                    Number(quote.deposit_amount ?? 0) -
                    Number(quote.commitment_invoice_amount ?? 0),
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
        quoteRef: (quote?.quote_ref as string | null) ?? null,
        quoteCustomer: (quote?.customer_name as string | null) ?? null,
        leadId: (quote?.lead_id as string | null) ?? null,
        expectedAmount,
        isSettlement: settlementRow(r),
      };
    };
    const last = syncRes.data?.[0];
    const lastSync = syncAgeLabel(last?.finished_at as string | null, last?.status === "ok");
    bank = {
      suggested: (sugRes.data ?? []).map(toTx),
      mismatches: (misRes.data ?? []).map(toTx),
      feedRows: feedData.map(toTx),
      unmatched: unmatchedRows.map((r) => {
        const hint = hintByTxId.get(r.id as string);
        return {
          ...toTx(r),
          settledHint: hint
            ? {
                quoteId: hint.quoteId,
                quoteRef: hint.quoteRef,
                customer: hint.customer,
                kind: hint.kind,
                leadId: hint.leadId,
              }
            : null,
        };
      }),
      lastSync,
    };
  }

  const chip = (active: boolean): string =>
    `focus-ring inline-flex min-h-9 items-center rounded-pill px-3.5 text-sm font-semibold transition-colors ${
      active ? "bg-mm-red text-white" : "border border-input bg-card text-mist-500 hover:bg-muted"
    }`;
  const activePreset = q && !params.range ? null : window.preset;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map(({ key, label }) => (
          <Link key={key} href={tabHref({ range: key, q: q || undefined })} className={chip(activePreset === key)}>
            {label}
          </Link>
        ))}
        <form action="/payments" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="range" value="custom" />
          {q ? <input type="hidden" name="q" value={q} /> : null}
          <input
            type="date"
            name="from"
            defaultValue={window.preset === "custom" ? window.startDay : ""}
            aria-label="From"
            className="focus-ring h-9 rounded-md border border-input bg-card px-2.5 text-sm text-foreground"
          />
          <input
            type="date"
            name="to"
            defaultValue={window.preset === "custom" ? window.endDay : ""}
            aria-label="To"
            className="focus-ring h-9 rounded-md border border-input bg-card px-2.5 text-sm text-foreground"
          />
          <button
            type="submit"
            className="focus-ring inline-flex min-h-9 items-center rounded-md border border-input bg-card px-3 text-sm font-medium text-mist-500 hover:bg-muted"
          >
            Go
          </button>
        </form>
        <form action="/payments" className="ml-auto flex items-center gap-2">
          {params.range ? <input type="hidden" name="range" value={params.range} /> : null}
          {params.from ? <input type="hidden" name="from" value={params.from} /> : null}
          {params.to ? <input type="hidden" name="to" value={params.to} /> : null}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-mist-400" strokeWidth={1.75} />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Customer or reference…"
              className="focus-ring h-9 w-56 rounded-md border border-input bg-card pl-8 pr-2.5 text-sm text-foreground"
            />
          </div>
        </form>
      </div>

      {q && !params.range ? (
        <p className="text-xs text-mist-400">
          Showing every payment matching “{q}” across all history.{" "}
          <Link href="/payments" className="font-medium text-mm-red hover:underline">
            Clear search
          </Link>
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Received"
          value={money(totals.totalPence)}
          sub={q ? `matching “${q}”` : window.label}
        />
        <Stat label="Card" value={money(totals.methodPence.card)} sub="takepayments, net of refunds" />
        <Stat
          label="Bank transfer"
          value={money(totals.methodPence.bank)}
          sub={
            totals.methodPence.unknown > 0
              ? `+ ${money(totals.methodPence.unknown)} method not recorded`
              : "marked paid in the panel"
          }
        />
        <Stat label="Cash" value={money(totals.methodPence.cash)} sub="marked paid in the panel" />
      </div>

      {unattributedPence > 0 ? (
        <p className="text-sm font-medium text-warn">
          {money(unattributedPence)} more arrived in this range and isn&apos;t recorded yet — attribute or
          clear it in the queues below.
        </p>
      ) : null}

      <Card className="p-0">
        <div className="flex items-center gap-2 border-b px-5 py-3.5">
          <Banknote className="size-4 text-mist-400" strokeWidth={1.75} />
          <h2 className="font-display text-lg text-foreground">Payments received</h2>
          <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
            {matched.length}
          </span>
        </div>
        {pageItems.length === 0 ? (
          <p className="px-5 py-6 text-sm text-mist-400">
            {q ? `No payments match “${q}”.` : "No payments in this range."}
          </p>
        ) : (
          dayGroups.map((group) => (
            <div key={group.day}>
              <div className="flex items-center justify-between border-b bg-muted/40 px-5 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-mist-500">
                  {dayHeading(group.day, todayDay)}
                </p>
                <p className="tabular text-xs font-semibold text-mist-500">{money(group.totalPence)}</p>
              </div>
              <div className="divide-y divide-mist-150">
                {group.items.map((i) => (
                  <ItemRow key={i.key} item={i} />
                ))}
              </div>
            </div>
          ))
        )}
        {pageCount > 1 ? (
          <div className="flex items-center justify-between border-t px-5 py-3">
            {page > 1 ? (
              <Link href={pageHref({ page: String(page - 1) })} className="text-sm font-medium text-mm-red hover:underline">
                ← Newer
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-mist-400">
              Page {page} of {pageCount}
            </span>
            {page < pageCount ? (
              <Link href={pageHref({ page: String(page + 1) })} className="text-sm font-medium text-mm-red hover:underline">
                Older →
              </Link>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </Card>

      {bank ? (
        <BankFeedSection
          suggested={bank.suggested}
          mismatches={bank.mismatches}
          dayRows={bank.feedRows}
          unmatched={bank.unmatched}
          dayLabelText={window.preset === "today" ? "today" : `between ${window.label}`}
          lastSync={bank.lastSync}
        />
      ) : null}
    </>
  );
}
