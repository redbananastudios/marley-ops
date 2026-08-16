import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import {
  applyBankFeedFloor,
  BANK_FEED_TAB,
  isAcquirerSettlement,
  isInboundPayment,
  parseSheetRows,
  resolveBankFeedFloor,
  type BankTxRow,
} from "@/lib/bank-feed/parse";
import {
  matchTransactionLedger,
  reconcileSettled,
  type OpenItem,
  type SettledItem,
} from "@/lib/bank-feed/match";
import { BANK_FEED_DIGEST_THRESHOLD, decideBankFeedPushes, type BankFeedArrival } from "@/lib/push/categories";
import { sendPushForEvent } from "@/lib/push/send";
import { errorContext, log } from "@/lib/log";

/**
 * Bank-feed sync (cron-driven): read the Monzo→Sheets export, upsert rows by
 * transaction id, and (re)match inbound payments against open deposits and
 * balances. Matching only ever produces SUGGESTIONS — the office confirms on
 * /payments, which runs the existing paid pipeline — and a suggestion always
 * carries the open item's EXACT amount (partial/over payments surface as
 * "mismatch" rows a human must record). Auth is a dedicated
 * spreadsheets.readonly refresh token (never the broad RBS token).
 */

const cfg = () => ({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_REFRESH_TOKEN_MARLEY_BANKFEED,
  sheetId: process.env.BANK_FEED_SHEET_ID,
});

export const bankFeedConfigured = (): boolean => {
  const c = cfg();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken && c.sheetId);
};

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const c = cfg();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId!,
      client_secret: c.clientSecret!,
      refresh_token: c.refreshToken!,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) throw new Error(`Bank-feed token refresh failed (${res.status})`);
  tokenCache = { token: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 3600) - 300) * 1000 };
  return tokenCache.token;
}

async function fetchSheet() {
  const c = cfg();
  const token = await accessToken();
  const range = encodeURIComponent(`${BANK_FEED_TAB}!A:Q`);
  // UNFORMATTED_VALUE so amounts arrive as raw numbers, immune to anyone
  // reformatting the Amount column (a "£1,020.00" display string would
  // otherwise silently drop exactly the biggest rows). FORMATTED_STRING for
  // date-times keeps Date as the DD/MM/YYYY string the parser expects.
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${c.sheetId}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = (await res.json().catch(() => ({}))) as { values?: (string | number)[][] };
  if (!res.ok) throw new Error(`Bank-feed sheet read failed (${res.status})`);
  return parseSheetRows(json.values ?? []);
}

/** Open deposits, commitment invoices + balances the matcher can suggest
 *  against — mirrors the Bookings page's definitions of "awaiting deposit"
 *  and "balance due"; commitment mirrors the chase engine's "invoiced, not
 *  paid". `settled` is the mirror image — items already PAID on the books —
 *  used only to reconcile transfers whose payment was recorded before the
 *  bank row arrived (never to run the paid pipeline). One query pass serves
 *  both so the two views can't disagree about a quote. */
export async function loadLedgerItems(
  sb: SupabaseClient,
): Promise<{ open: OpenItem[]; settled: SettledItem[] }> {
  const quotes = await fetchAllRows((f, t) =>
    sb
      .from("quotes")
      .select(
        "id, quote_ref, lead_id, customer_name, status, deposit_amount, deposit_paid_at, balance_invoice_amount, agreed_price, grand_total, commitment_invoice_amount, commitment_paid_at, booking_cancelled_at",
      )
      .eq("status", "accepted")
      .order("id")
      .range(f, t),
    // strict: this set defines what an incoming payment is ALLOWED to match
    // against. Failing soft would hand the matcher half a ledger, and real
    // customer money would sit 'unmatched' for a human who has no way of
    // knowing the matcher was working from a partial view.
    { strict: true },
  );

  // Balance-paid lookup: only deposit-paid quotes can yield a balance item,
  // and the .in() must be CHUNKED — a few hundred uuids in one GET blows the
  // gateway's URL/header limit (the quotes-search 414, session 32d), and the
  // old silent `const { data } = …` would then treat EVERY balance as open.
  const leadIds = [
    ...new Set(quotes.filter((q) => q.deposit_paid_at && q.lead_id).map((q) => q.lead_id as string)),
  ];
  const leadBalance = new Map<string, { paidAt: string | null; amount: number | null }>();
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100);
    const { data, error } = await sb
      .from("leads")
      .select("id, balance_paid_at, balance_amount")
      .in("id", chunk);
    if (error) throw new Error(`bank-feed lead lookup failed: ${error.message}`);
    for (const l of data ?? [])
      leadBalance.set(l.id as string, {
        paidAt: (l.balance_paid_at as string | null) ?? null,
        amount: l.balance_amount == null ? null : Number(l.balance_amount),
      });
  }

  const open: OpenItem[] = [];
  const settled: SettledItem[] = [];
  for (const q of quotes) {
    const base = {
      quoteId: q.id as string,
      quoteRef: (q.quote_ref as string) ?? "",
      leadId: (q.lead_id as string | null) ?? null,
      customer: (q.customer_name as string | null) ?? null,
    };
    if (!base.quoteRef) continue;
    // A cancelled booking must never suggest money actions — its unwind
    // (refunds, reopen) owns that state, not the bank feed. Its already-
    // RECORDED payments stay in the settled pool: that money really arrived,
    // and its bank row must not read as unexplained.
    const cancelled = Boolean(q.booking_cancelled_at);

    // Invoices PARTITION the agreed price (computeBalanceCredits): once a
    // commitment invoice is RAISED (paid or not), the balance is agreed −
    // deposit − commitment. Without the carve-out the open set would offer
    // commitment + gross balance simultaneously — more than is owed.
    const lead = q.lead_id ? leadBalance.get(q.lead_id) : undefined;
    const balanceAmount =
      Number(q.balance_invoice_amount) ||
      Math.max(
        0,
        Number(q.agreed_price ?? q.grand_total ?? 0) -
          Number(q.deposit_amount ?? 0) -
          Number(q.commitment_invoice_amount ?? 0),
      );

    if (q.deposit_paid_at && Number(q.deposit_amount) > 0) {
      settled.push({ ...base, kind: "deposit", amount: Number(q.deposit_amount) });
    } else if (!cancelled && !q.deposit_paid_at && Number(q.deposit_amount) > 0) {
      open.push({ ...base, kind: "deposit", amount: Number(q.deposit_amount) });
    }

    if (q.deposit_paid_at && q.lead_id) {
      if (lead?.paidAt) {
        // markBalancePaid can settle the LEAD's own balance figure when one was
        // set by hand — reconcile against that where present.
        const amount = lead.amount ?? balanceAmount;
        if (amount > 0) settled.push({ ...base, kind: "balance", amount });
      } else if (!cancelled && balanceAmount > 0) {
        open.push({ ...base, kind: "balance", amount: balanceAmount });
      }
    }

    // Commitment: invoiced (amount only ever set when the Zoho invoice landed).
    // Open items are pushed AFTER deposit/balance so suffix-less same-amount
    // ties keep today's deposit-first pick.
    if (Number(q.commitment_invoice_amount) > 0) {
      if (q.commitment_paid_at) {
        settled.push({ ...base, kind: "commitment", amount: Number(q.commitment_invoice_amount) });
      } else if (!cancelled) {
        open.push({ ...base, kind: "commitment", amount: Number(q.commitment_invoice_amount) });
      }
    }
  }
  return { open, settled };
}

/** The open half only — the /payments manual attach flow validates against
 *  exactly the same open-item set the matcher uses. */
export async function loadOpenItems(sb: SupabaseClient): Promise<OpenItem[]> {
  return (await loadLedgerItems(sb)).open;
}

// Type alias (not interface) so it satisfies runCron's Record<string, unknown>.
export type BankFeedSyncSummary = {
  disabled?: boolean;
  rowsInSheet: number;
  /** Rows with a transaction id the parser could not safely ingest. */
  skippedRows: number;
  upserted: number;
  suggested: number;
  mismatched: number;
  unmatched: number;
  /** Transfers tied to an already-recorded payment (paid via Zoho/manual
   *  before their bank row was processed) — no paid pipeline, no page. */
  reconciled?: number;
  /** Acquirer settlement payouts (Elavon/takepayments) kept out of the queues. */
  settlements?: number;
  /** Admin push notifications fired for transfers surfaced THIS pass. */
  notified: number;
};

/** Monzo mutates recent rows (settlements, enrichment); older settled rows
 *  never change. Re-writing all ~1,900 rows every 2 minutes burned WAL and
 *  updated_at for nothing — only new rows and this window get upserted. */
const MUTABLE_WINDOW_DAYS = 35;

/** Distinct from the upsert window above (which governs sheet re-writes):
 *  only transfers this recent may form a NEW suggestion or page the admins.
 *  Without it a stale unmatched transfer — pre-feed history, or a £100 the
 *  office recorded manually without dismissing the row — re-competes every
 *  pass, hijacks each new sole open deposit and re-pages false "one tap to
 *  confirm" alerts. Older rows stay visible on /payments as unmatched. */
const SUGGESTION_FRESH_DAYS = 14;

export async function syncBankFeed(sb: SupabaseClient): Promise<BankFeedSyncSummary> {
  if (!bankFeedConfigured()) {
    return {
      disabled: true,
      rowsInSheet: 0,
      skippedRows: 0,
      upserted: 0,
      suggested: 0,
      mismatched: 0,
      unmatched: 0,
      notified: 0,
    };
  }
  const { rows: sheetRows, skipped } = await fetchSheet();

  // Go-live floor — mirrors the Sanity LEAD_SYNC_SINCE no-backfill floor
  // (lib/sync/sync-window.ts). The Monzo→Sheets export holds history back to
  // April 2025; without this the first sync into the flushed go-live DB would
  // upsert every pre-go-live row.
  //
  // FAIL CLOSED: on the flushed live system a missing/garbled BANK_FEED_SINCE
  // must NOT default to "no floor" (that re-imports the whole pre-go-live
  // history). If we can't resolve a valid ISO floor while the feed is otherwise
  // configured, refuse to import and log — the env is set in prod, so this only
  // trips on a real misconfiguration (reviewer, 2026-07-30).
  const floor = resolveBankFeedFloor(process.env.BANK_FEED_SINCE);
  if (!floor) {
    log.warn("bank-feed.floor_missing", { raw: process.env.BANK_FEED_SINCE ?? null });
    return {
      disabled: true,
      rowsInSheet: sheetRows.length,
      skippedRows: skipped,
      upserted: 0,
      suggested: 0,
      mismatched: 0,
      unmatched: 0,
      notified: 0,
    };
  }
  // Applied to the parsed rows BEFORE the upsert, so both the upsert AND the
  // downstream arrival/digest counting (which only ever see rows that reached
  // bank_transactions) respect it.
  const rows = applyBankFeedFloor(sheetRows, floor);

  // What we already hold, and which rows the office has settled — confirmed/
  // dismissed/reconciled rows are NEVER rewritten (their amount/reference are
  // part of the audit trail of what was on screen at settle time, and a
  // reconcile was made on exactly that reference+amount).
  const existing = await fetchAllRows((f, t) =>
    sb.from("bank_transactions").select("transaction_id, status").order("id").range(f, t),
  );
  const known = new Set(existing.map((r) => r.transaction_id as string));
  const locked = new Set(
    existing
      .filter((r) => r.status === "confirmed" || r.status === "dismissed" || r.status === "reconciled")
      .map((r) => r.transaction_id as string),
  );

  const cutoff = new Date(Date.now() - MUTABLE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const toUpsert = rows.filter(
    (r) => !locked.has(r.transactionId) && (!known.has(r.transactionId) || r.txDate >= cutoff),
  );

  let upserted = 0;
  for (let i = 0; i < toUpsert.length; i += 500) {
    const chunk = toUpsert.slice(i, i + 500).map((r: BankTxRow) => ({
      transaction_id: r.transactionId,
      tx_date: r.txDate,
      tx_time: r.txTime,
      tx_type: r.txType,
      counterparty: r.counterparty,
      amount: r.amount,
      currency: r.currency,
      reference: r.reference,
      description: r.description,
      raw: r.raw as never,
    }));
    const { error } = await sb
      .from("bank_transactions")
      .upsert(chunk as never, { onConflict: "transaction_id", ignoreDuplicates: false });
    if (error) throw new Error(`bank_transactions upsert failed: ${error.message}`);
    upserted += chunk.length;
  }

  // (Re)match every inbound row the office hasn't dealt with. Suggestions are
  // recomputed each pass so a newly-raised invoice can claim an older unmatched
  // transfer — but confirmed/dismissed rows are never touched, and every write
  // below is status-guarded so a concurrent Confirm/Dismiss always wins.
  const { open, settled } = await loadLedgerItems(sb);
  const pending = await fetchAllRows((f, t) =>
    sb
      .from("bank_transactions")
      .select(
        "id, tx_date, amount, tx_type, counterparty, reference, description, status, matched_quote_id, match_kind, match_confidence",
      )
      .in("status", ["info", "unmatched", "suggested"])
      .order("id")
      .range(f, t),
  );

  // First-wins per open item within a pass: once a transfer is suggested for
  // an item, a second transfer (a duplicate payment) can't also be suggested
  // for it — it falls through to unmatched/mismatch for a human.
  const remaining = [...open];
  const consume = (quoteId: string, kind: string) => {
    const idx = remaining.findIndex((o) => o.quoteId === quoteId && o.kind === kind);
    if (idx >= 0) remaining.splice(idx, 1);
  };

  let suggested = 0;
  let mismatched = 0;
  let unmatched = 0;
  let reconciled = 0;
  // Transfers SURFACED this pass (fresh inbound money, or an old unmatched
  // transfer a newly-raised invoice just claimed) — these page the admins.
  const arrivals: BankFeedArrival[] = [];
  const freshCutoff = new Date(Date.now() - SUGGESTION_FRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
  let settlements = 0;
  for (const row of pending) {
    const inbound = isInboundPayment({ amount: Number(row.amount), txType: row.tx_type as string | null });
    if (!inbound) continue; // stays info

    // An acquirer settlement (Elavon paying out card takings) is inbound by
    // type but NOT customer money to record — the card payment already ran the
    // paid pipeline. Keep it out of matching and the queues; demote one that a
    // pre-classifier pass already surfaced as unmatched back to info
    // (status-guarded, so a concurrent office action always wins). It stays
    // browsable on the /payments day feed with a "Card settlement" chip.
    if (isAcquirerSettlement({ counterparty: row.counterparty as string | null, reference: row.reference as string | null })) {
      if (row.status === "unmatched" && !row.matched_quote_id) {
        const { error: demoteError } = await sb
          .from("bank_transactions")
          .update({ status: "info", matched_quote_id: null, match_kind: null, match_confidence: null } as never)
          .eq("id", row.id)
          .eq("status", "unmatched");
        if (demoteError) log.error("bank-feed.settlement-demote.failed", { txId: row.id as string, error: demoteError.message });
        else settlements++;
      }
      continue;
    }
    // Stale transfers can't form a NEW suggestion (they'd consume the open
    // item a fresh transfer is really for); an EXISTING suggestion stays
    // re-matchable so it keeps tracking its open item until confirmed.
    const freshTx = (row.tx_date as string) >= freshCutoff;
    const txInput = {
      amount: Number(row.amount),
      reference: row.reference as string | null,
      description: row.description as string | null,
      counterparty: row.counterparty as string | null,
    };
    // Reconciling against a SETTLED item applies at any age — it consumes no
    // open item and never pages, so the stale freeze doesn't apply to it. A
    // stale unmatched row that still won't reconcile stays exactly as the
    // office sees it (incl. any mismatch pointer) — no re-match, no rewrite.
    const m =
      freshTx || row.status === "suggested"
        ? matchTransactionLedger(txInput, remaining, settled)
        : reconcileSettled(txInput, settled);
    if (!freshTx && row.status === "unmatched" && !m) continue;
    let next: {
      status: string;
      matched_quote_id: string | null;
      match_kind: string | null;
      match_confidence: string | null;
    };
    if (m?.type === "suggestion") {
      next = { status: "suggested", matched_quote_id: m.quoteId, match_kind: m.kind, match_confidence: m.confidence };
      consume(m.quoteId, m.kind);
      suggested++;
    } else if (m?.type === "reconciled") {
      // The referenced payment is already on the books (recorded via Zoho or a
      // manual mark-paid before this bank row was processed). Link the row so
      // the money reads as explained — the paid pipeline must NOT run again.
      next = { status: "reconciled", matched_quote_id: m.quoteId, match_kind: m.kind, match_confidence: "reference" };
      reconciled++;
    } else if (m?.type === "mismatch") {
      // Right quote, wrong amount — visible on /payments, never confirmable.
      next = { status: "unmatched", matched_quote_id: m.quoteId, match_kind: m.kind, match_confidence: null };
      mismatched++;
    } else if (m?.type === "storage") {
      next = { status: "suggested", matched_quote_id: null, match_kind: "storage", match_confidence: "reference" };
      suggested++;
    } else {
      next = { status: "unmatched", matched_quote_id: null, match_kind: null, match_confidence: null };
      unmatched++;
    }
    const changed =
      next.status !== row.status ||
      next.matched_quote_id !== (row.matched_quote_id ?? null) ||
      next.match_kind !== (row.match_kind ?? null) ||
      next.match_confidence !== (row.match_confidence ?? null);
    if (changed) {
      // Status guard: if the office confirmed/dismissed this row since our
      // snapshot, this update matches 0 rows and their action stands — and a
      // zero-row claim must never page (the row is no longer pending).
      let claimed = false;
      try {
        const { data, error } = await sb
          .from("bank_transactions")
          .update(next as never)
          .eq("id", row.id)
          .in("status", ["info", "unmatched", "suggested"])
          .select("id");
        if (error) throw new Error(error.message);
        claimed = (data ?? []).length > 0;
      } catch (e) {
        // One failed write must not swallow the pushes for transfers already
        // transitioned this pass — the untouched row retries next tick.
        log.error("bank-feed.match-update.failed", { txId: row.id as string, ...errorContext(e) });
        continue;
      }

      // Push-worthy = a FRESH transfer ENTERING the queue: info→suggested/
      // unmatched (fresh money in) or unmatched→suggested (an invoice claimed
      // it). A re-pointed suggestion, a mismatch flip on an already-surfaced
      // row, or stale first-sync history transitioning stays silent.
      const enteredSuggested = next.status === "suggested" && row.status !== "suggested";
      const freshUnmatched = next.status === "unmatched" && row.status === "info";
      if (claimed && freshTx && (enteredSuggested || freshUnmatched)) {
        const quoteId = m && m.type !== "storage" ? m.quoteId : null;
        const item = quoteId ? open.find((o) => o.quoteId === quoteId) : undefined;
        arrivals.push({
          rowId: row.id as string,
          outcome: enteredSuggested ? "suggested" : "attention",
          kind: (next.match_kind ?? null) as BankFeedArrival["kind"],
          name: item?.customer ?? (row.counterparty as string | null) ?? null,
          quoteRef: item?.quoteRef ?? null,
        });
      }
    }
  }

  // Page the ADMINS (Peter + Connor — their explicit ask; estimators keep
  // getting the post-confirm "Deposit received" push instead). Best-effort:
  // sendPushForEvent never throws, and the payment_event kill switch applies.
  // A digest replaces any earlier digest (constant OS tag), so it must carry
  // the TOTAL still pending — not just this pass's arrivals.
  let totalPending = 0;
  if (arrivals.length > BANK_FEED_DIGEST_THRESHOLD) {
    const { count } = await sb
      .from("bank_transactions")
      .select("id", { count: "exact", head: true })
      .in("status", ["suggested", "unmatched"]);
    totalPending = count ?? 0;
  }
  const events = decideBankFeedPushes(arrivals, totalPending);
  if (events.length > 0) {
    const { data: admins } = await sb.from("profiles").select("id").eq("role", "admin").eq("active", true);
    const adminIds = (admins ?? []).map((a: { id: string }) => a.id);
    for (const event of events) {
      await sendPushForEvent(event, { recipientUserIds: adminIds });
    }
  }

  return {
    // Full parsed-sheet count (pre-floor) — keeps the /automations metric
    // meaning "rows the export contained"; `upserted` reflects the floored set.
    rowsInSheet: sheetRows.length,
    skippedRows: skipped,
    upserted,
    suggested,
    mismatched,
    unmatched,
    reconciled,
    settlements,
    notified: events.length,
  };
}
