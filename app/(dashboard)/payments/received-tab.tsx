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
import { errorContext, log } from "@/lib/log";
import type { Brand } from "@/lib/brand";
import { applyBrandFilter, BRAND_FILTER_PARAM } from "@/lib/brand-filter";
import { BrandChip, type BrandChipData } from "@/components/brand/brand-chip";
import { BrandFilter } from "@/components/brand/brand-filter";
import { Card } from "@/components/ui/card";
import { bankFeedConfigured, loadLedgerItems } from "@/lib/bank-feed/sync";
import { suggestSettledLink, type OpenItem, type SettledItem } from "@/lib/bank-feed/match";
import { coveringPairLinks, type CoveringPairLink } from "@/lib/bank-feed/whole-quote";
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

function ItemRow({ item, chip }: { item: ReceivedItem; chip?: BrandChipData }) {
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
        {/* Brand chip — the customer column (multi-brand PRD §4 Payments);
            hidden when ?brand= already names one brand. */}
        {chip ? <BrandChip brand={chip} className="ml-2 align-middle" /> : null}
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

export async function ReceivedTab({
  params,
  activeBrands,
  multi,
  brandFilter,
}: {
  params: ReceivedParams;
  /** Active brands (multi-brand PRD §4) — filter options + chip data. */
  activeBrands: Brand[];
  multi: boolean;
  /** `'all'` or an active brand slug (already validated by parseBrandParam). */
  brandFilter: string;
}) {
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
  // Brand narrowing (multi-brand PRD §4 Payments) happens IN THE DB on the
  // stamp reads — quotes and leads both carry a denormalised `brand` column.
  // applyBrandFilter is a no-op at 'all', so the single-brand path is
  // byte-identical to today (the single-brand invariant, PRD §1).
  const [{ data: allCardRows }, { data: depositQuotes }, { data: commitmentQuotes }, { data: balanceLeads }] =
    await Promise.all([
      sb
        .from("card_payments")
        .select(
          "id, kind, status, amount_pence, refunded_pence, is_test, settled_at, refunded_at, refund_reason, quote_id, lead_id, card_number_mask, card_scheme",
        )
        .or(
          `and(settled_at.gte.${startIso},settled_at.lt.${endIso}),and(refunded_at.gte.${startIso},refunded_at.lt.${endIso})`,
        ),
      // A re-quote CARRIES the paid deposit onto the new quote and leaves it on
      // the old one (supersedeSiblingQuotes), so one £100 deposit exists on two
      // rows and an unfiltered range query counts it twice. Retired quotes are
      // excluded on every other money surface (sales-report, dashboard) — here
      // too. `superseded` is the live shape; `draft`/`rejected` can't hold a
      // real payment but cost nothing to exclude.
      applyBrandFilter(
        sb
          .from("quotes")
          .select(QUOTE_COLS)
          .in("status", ["accepted", "sent"]),
        brandFilter,
      )
        .gte("deposit_paid_at", startIso)
        .lt("deposit_paid_at", endIso),
      applyBrandFilter(
        sb
          .from("quotes")
          .select(`${QUOTE_COLS}, commitment_paid_at, commitment_paid_method`)
          .in("status", ["accepted", "sent"]),
        brandFilter,
      )
        .gte("commitment_paid_at", startIso)
        .lt("commitment_paid_at", endIso),
      applyBrandFilter(
        sb.from("leads").select("id, name, balance_paid_at, balance_amount, balance_paid_method"),
        brandFilter,
      )
        .gte("balance_paid_at", startIso)
        .lt("balance_paid_at", endIso),
    ]);

  // card_payments carries no brand column, so a named filter narrows card rows
  // through a supplementary CHUNKED fail-loud leads read (the /bookings
  // precedent — a silent cap or failed read here would DROP payments, not
  // degrade them). A card row with no lead can't be attributed to a brand and
  // drops from a named-brand view; the default All view remains the full truth.
  let cardRows = allCardRows ?? [];
  if (brandFilter !== "all" && cardRows.length) {
    const cardLeadIds = [...new Set(cardRows.map((r) => r.lead_id).filter(Boolean) as string[])];
    const brandLeads = new Set<string>();
    // 100-id batches: PostgREST .in() rides the GET query string and the
    // gateway 414s past ~200 UUIDs (lib/bank-feed/sync.ts measured the limit).
    for (let i = 0; i < cardLeadIds.length; i += 100) {
      const { data: leadRows, error: leadErr } = await applyBrandFilter(
        sb.from("leads").select("id").in("id", cardLeadIds.slice(i, i + 100)),
        brandFilter,
      );
      if (leadErr) throw new Error(`payments: card brand read failed: ${leadErr.message}`);
      for (const l of leadRows ?? []) brandLeads.add(l.id);
    }
    cardRows = cardRows.filter((r) => r.lead_id && brandLeads.has(r.lead_id));
  }

  // Names/refs for card + balance rows come from the lead's accepted quote.
  const leadIds = [
    ...new Set(
      [
        ...cardRows.map((r) => r.lead_id),
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
        .in("match_kind", ["deposit", "commitment", "balance", "full"])
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
        .in("match_kind", ["deposit", "commitment", "balance", "full"])
        .in("matched_quote_id", stampQuoteIds.slice(i, i + 100));
      matchRows.push(...(data ?? []));
    }
    const seenQk = new Set<string>();
    for (const r of matchRows) {
      if (!r.matched_quote_id || !r.match_kind) continue;
      // 'full' is one transfer that paid the whole job, so it is the arrival-day
      // truth for EVERY payment on that quote — expanding it here keeps those
      // lines from reading "Method not recorded" with no bank date. Stamps for a
      // kind the quote does not have are inert: nothing ever looks them up.
      const kinds =
        r.match_kind === "full"
          ? (["deposit", "commitment", "balance"] as const)
          : ([r.match_kind] as const);
      for (const kind of kinds) {
        const qk = `${r.matched_quote_id}:${kind}`;
        if (seenQk.has(qk)) continue;
        seenQk.add(qk);
        bankMatches.push({
          quoteId: r.matched_quote_id,
          kind: kind as BankMatchIn["kind"],
          txDate: r.tx_date,
          txTime: r.tx_time,
        });
      }
    }
    // These lookups decide whether a bank-matched payment can be EMITTED, while
    // its stamp twin is already suppressed on the strength of `bankMatches`.
    // So a silent failure here doesn't degrade the page — it deletes real
    // payments from the ledger and just shows a smaller total. Chunk the `.in()`
    // (an unchunked one 414s once the list grows, exactly as the matcher's lead
    // lookup already learned) and throw rather than under-report money.
    const matchQuoteIds = [...new Set(bankMatches.map((m) => m.quoteId))];
    for (let i = 0; i < matchQuoteIds.length; i += 100) {
      // Brand-narrowed in the DB too: buildReceivedDay skips a bank match whose
      // quote is missing from this map, so filtering here keeps another brand's
      // in-range arrivals from emitting items under a named ?brand= view.
      const { data: mq, error: mqErr } = await applyBrandFilter(
        sb
          .from("quotes")
          .select(`${QUOTE_COLS}, commitment_paid_at, commitment_paid_method`)
          .in("id", matchQuoteIds.slice(i, i + 100)),
        brandFilter,
      );
      if (mqErr) throw new Error(`payments: bank-matched quote lookup failed: ${mqErr.message}`);
      for (const quote of mq ?? []) bankQuoteById.set(quote.id as string, quote);
    }
    const mLeadIds = [...new Set([...bankQuoteById.values()].map((quote) => quote.lead_id).filter(Boolean))] as string[];
    for (let i = 0; i < mLeadIds.length; i += 100) {
      const { data: ml, error: mlErr } = await sb
        .from("leads")
        .select("id, name, balance_paid_at, balance_amount, balance_paid_method")
        .in("id", mLeadIds.slice(i, i + 100));
      if (mlErr) throw new Error(`payments: bank-matched lead lookup failed: ${mlErr.message}`);
      for (const l of ml ?? []) bankLeadById.set(l.id as string, l);
    }
  }

  const assembled = buildReceivedDay({
    window,
    cardRows,
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

  // Brand chips on the rendered rows — hidden when the segmented control
  // already names one brand (multi-brand PRD §4 opening rules). ReceivedItem
  // carries no brand (lib/payments is shared), so the on-screen page's leads
  // resolve it in one batched read. Fail SOFT: this read only decorates rows
  // with a chip — losing a chip is a lost convenience; losing the money page
  // is a lost money page (the link-hints precedent below). Row NARROWING never
  // rides this read — that happened in the DB above.
  const showBrandChips = multi && brandFilter === "all";
  const chipBySlug = new Map(activeBrands.map((b) => [b.slug, b]));
  const brandByLead = new Map<string, string>();
  if (showBrandChips && pageItems.length) {
    const pageLeadIds = [...new Set(pageItems.map((i) => i.leadId).filter(Boolean) as string[])];
    for (let i = 0; i < pageLeadIds.length; i += 100) {
      const { data: leadRows, error: leadErr } = await sb
        .from("leads")
        .select("id, brand")
        .in("id", pageLeadIds.slice(i, i + 100));
      if (leadErr) {
        log.error("payments.brand-chips.read_failed", { error: leadErr.message });
        break;
      }
      for (const l of leadRows ?? []) brandByLead.set(l.id, l.brand);
    }
  }
  const chipFor = (item: ReceivedItem): BrandChipData | undefined =>
    showBrandChips && item.leadId ? chipBySlug.get(brandByLead.get(item.leadId) ?? "") : undefined;

  const pageHref = (over: Partial<Record<string, string>>): string =>
    tabHref({
      range: params.range,
      from: params.from,
      to: params.to,
      q: q || undefined,
      [BRAND_FILTER_PARAM]: brandFilter !== "all" ? brandFilter : undefined,
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
    /** True totals behind each capped list — the badge must never render the
     *  cap as if it were the whole queue. */
    totals: { suggested: number | null; mismatches: number | null; unmatched: number | null; feed: number | null };
    readFailed: boolean;
  } | null = null;
  if (bankFeedConfigured()) {
    const TX_COLS =
      "id, tx_date, tx_time, counterparty, amount, reference, description, status, match_kind, match_confidence, matched_quote_id";
    // Every queue asks for an EXACT count alongside its page of rows: the badge
    // used to render `rows.length`, i.e. the cap itself, so a truncated queue
    // looked like a complete one — on the page whose whole job is telling Peter
    // nothing is missed. Rows are newest-first, so it's the oldest (most
    // forgotten) item that falls off.
    const [sugRes, misRes, feedRes, settlementRes, unmatchedRes, syncRes] = await Promise.all([
      sb
        .from("bank_transactions")
        .select(TX_COLS, { count: "exact" })
        .eq("status", "suggested")
        .order("tx_date", { ascending: false })
        .limit(20),
      // Mismatches: a transfer that NAMES an open quote at the wrong amount
      // (part-payment / duplicate) — unmatched status but with a match_kind.
      sb
        .from("bank_transactions")
        .select(TX_COLS, { count: "exact" })
        .eq("status", "unmatched")
        .not("matched_quote_id", "is", null)
        .order("tx_date", { ascending: false })
        .limit(10),
      sb
        .from("bank_transactions")
        .select(TX_COLS, { count: "exact" })
        .gte("tx_date", window.startDay)
        .lte("tx_date", window.endDay)
        // Dismissed money is cleared and must disappear from the feed (it's
        // already off the counts). `info` rows — outbound spend, pot moves,
        // wages — are noise here and are excluded IN THE QUERY: filtering them
        // after a .limit() let 60 rows of noise consume the budget and push
        // real inbound transfers off the day feed. Card settlements are also
        // `info` and are fetched separately below, on their own budget, so
        // neither can starve the other.
        .not("status", "in", '("dismissed","info")')
        .order("tx_date", { ascending: false })
        .order("tx_time", { ascending: false })
        .limit(60),
      // Acquirer settlements (Elavon/takepayments paying out card takings).
      // Fetched as raw `info` rows and classified in JS by isAcquirerSettlement,
      // which stays the single authority on what a settlement is — encoding
      // that rule a second time in SQL is exactly how two copies drift apart.
      sb
        .from("bank_transactions")
        .select(TX_COLS)
        .eq("status", "info")
        .gte("tx_date", window.startDay)
        .lte("tx_date", window.endDay)
        .order("tx_date", { ascending: false })
        .order("tx_time", { ascending: false })
        .limit(60),
      // Plain unmatched inbound across ALL dates — money we don't recognise
      // (old-system transfers, non-customer credits). matched_quote_id is null
      // so this never overlaps the mismatch queue (those NAME a quote).
      sb
        .from("bank_transactions")
        .select(TX_COLS, { count: "exact" })
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

    // Every bank read here decides what the office is told about money. A
    // silent `?? []` turns any of them into "there's nothing to see", which on
    // this page is a lie with consequences — so surface the failure instead.
    const bankReadFailed = [sugRes, misRes, feedRes, settlementRes, unmatchedRes].some((r) => r.error);
    if (bankReadFailed) {
      log.error("payments.bank-queues.read_failed", {
        errors: [sugRes, misRes, feedRes, settlementRes, unmatchedRes]
          .map((r) => r.error?.message)
          .filter(Boolean),
      });
    }

    // "Already recorded" hints for the unmatched queue: exact pennies + the
    // payer/reference name corroborating exactly ONE settled item (Dingley's
    // £1,100 "DINGLEY" while Emma Dingley's balance is on the books). Display
    // layer only — auto-reconcile stays reference-only; the office taps Link.
    const unmatchedRows = unmatchedRes.data ?? [];
    const mismatchRows = misRes.data ?? [];
    const hintByTxId = new Map<string, SettledItem>();
    const pairHintByTxId = new Map<string, CoveringPairLink>();
    if (unmatchedRows.length || mismatchRows.length) {
      // Fail SOFT. loadLedgerItems reads strictly (it throws rather than hand
      // back half a ledger), which is right for the matcher — but here it only
      // decorates rows with a "looks already recorded" hint. Losing the hint
      // is a lost convenience; losing the money page is a lost money page.
      const ledger = await loadLedgerItems(sb).then(
        (l) => l,
        (e) => {
          log.error("payments.link-hints.failed", { ...errorContext(e) });
          return { open: [] as OpenItem[], settled: [] as SettledItem[] };
        },
      );
      for (const r of unmatchedRows) {
        const hint = suggestSettledLink(
          {
            amount: Number(r.amount),
            reference: (r.reference as string | null) ?? null,
            description: (r.description as string | null) ?? null,
            counterparty: (r.counterparty as string | null) ?? null,
          },
          ledger.settled,
        );
        if (hint) hintByTxId.set(r.id as string, hint);
      }
      // Covering-pair hints for the mismatch queue: the gate-9c settle-in-full
      // transfer names its quote but equals no single open item — it equals the
      // open commitment + balance SUM to the penny. Display layer only, on the
      // quote the transfer itself names; the office confirms and BOTH payments
      // are recorded (app/actions/bank-feed.ts recordCoveringPairAction). Rows
      // parked as possible duplicates are money we may owe back — never hinted.
      for (const r of mismatchRows) {
        if (!r.matched_quote_id || r.match_confidence === "duplicate") continue;
        const pair = coveringPairLinks(ledger.open, Math.round(Number(r.amount) * 100)).find(
          (p) => p.quoteId === r.matched_quote_id,
        );
        if (pair) pairHintByTxId.set(r.id as string, pair);
      }
    }
    // Real activity for the range, plus the acquirer payouts from the separate
    // `info` budget, re-sorted so the day feed still reads chronologically.
    const settlements = (settlementRes.data ?? []).filter(settlementRow);
    const feedData = [...(feedRes.data ?? []), ...settlements].sort((a, b) => {
      const day = String(b.tx_date).localeCompare(String(a.tx_date));
      return day !== 0 ? day : String(b.tx_time ?? "").localeCompare(String(a.tx_time ?? ""));
    });
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
      mismatches: mismatchRows.map((r) => {
        const pair = pairHintByTxId.get(r.id as string);
        return {
          ...toTx(r),
          coveringPairHint: pair
            ? { commitmentAmount: pair.commitmentAmount, balanceAmount: pair.balanceAmount }
            : null,
        };
      }),
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
      totals: {
        suggested: sugRes.count ?? null,
        mismatches: misRes.count ?? null,
        unmatched: unmatchedRes.count ?? null,
        feed: feedRes.count ?? null,
      },
      readFailed: bankReadFailed,
    };
  }

  const chip = (active: boolean): string =>
    `focus-ring inline-flex min-h-9 items-center rounded-pill px-3.5 text-sm font-semibold transition-colors ${
      active ? "bg-mm-red text-white" : "border border-input bg-card text-mist-500 hover:bg-muted"
    }`;
  const activePreset = q && !params.range ? null : window.preset;

  const brandParam = brandFilter !== "all" ? brandFilter : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* Brand filter (multi-brand PRD §4 Payments) — the segmented control
            joins the Received tab's search row. */}
        {multi ? (
          <BrandFilter
            brands={activeBrands.map((b) => ({ slug: b.slug, name: b.name, shortName: b.shortName }))}
          />
        ) : null}
        {PRESETS.map(({ key, label }) => (
          <Link
            key={key}
            href={tabHref({ range: key, q: q || undefined, [BRAND_FILTER_PARAM]: brandParam })}
            className={chip(activePreset === key)}
          >
            {label}
          </Link>
        ))}
        <form action="/payments" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="range" value="custom" />
          {q ? <input type="hidden" name="q" value={q} /> : null}
          {/* GET forms rebuild the URL from their inputs, so ?brand= must ride
              a hidden field to survive the submit (the gate-3 search rule). */}
          {brandParam ? <input type="hidden" name={BRAND_FILTER_PARAM} value={brandParam} /> : null}
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
          {brandParam ? <input type="hidden" name={BRAND_FILTER_PARAM} value={brandParam} /> : null}
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
          <Link
            href={tabHref({ [BRAND_FILTER_PARAM]: brandParam })}
            className="font-medium text-mm-red hover:underline"
          >
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
                  <ItemRow key={i.key} item={i} chip={chipFor(i)} />
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

      {/* The bank-feed queues below are BUSINESS-WIDE and unfiltered by design,
          like the ExceptionsStrip (multi-brand PRD §4 Payments): unmatched and
          suggested transfers are money we haven't attributed yet, so a brand
          filter cannot apply to them — unexplained money is unexplained
          regardless of brand, and hiding it on a filtered view would silence
          the one surface whose job is to surface it. Same for the
          "more arrived in this range" honesty line above. */}
      {bank ? (
        <BankFeedSection
          suggested={bank.suggested}
          mismatches={bank.mismatches}
          dayRows={bank.feedRows}
          unmatched={bank.unmatched}
          dayLabelText={window.preset === "today" ? "today" : `between ${window.label}`}
          lastSync={bank.lastSync}
          totals={bank.totals}
          readFailed={bank.readFailed}
        />
      ) : null}
    </>
  );
}
