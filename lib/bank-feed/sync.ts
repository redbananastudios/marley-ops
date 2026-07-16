import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/fetch-all";
import { BANK_FEED_TAB, isInboundPayment, parseSheetRows, type BankTxRow } from "@/lib/bank-feed/parse";
import { matchTransaction, type OpenItem } from "@/lib/bank-feed/match";

/**
 * Bank-feed sync (cron-driven): read the Monzo→Sheets export, upsert rows by
 * transaction id, and (re)match inbound payments against open deposits and
 * balances. Matching only ever produces SUGGESTIONS — the office confirms on
 * /payments, which runs the existing paid pipeline. Auth is a dedicated
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

async function fetchSheetRows(): Promise<BankTxRow[]> {
  const c = cfg();
  const token = await accessToken();
  const range = encodeURIComponent(`${BANK_FEED_TAB}!A:Q`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${c.sheetId}/values/${range}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = (await res.json().catch(() => ({}))) as { values?: string[][] };
  if (!res.ok) throw new Error(`Bank-feed sheet read failed (${res.status})`);
  return parseSheetRows(json.values ?? []);
}

/** Open deposits + balances the matcher can suggest against — mirrors the
 *  Bookings page's definitions of "awaiting deposit" and "balance due". */
async function loadOpenItems(sb: SupabaseClient): Promise<OpenItem[]> {
  const quotes = await fetchAllRows((f, t) =>
    sb
      .from("quotes")
      .select(
        "id, quote_ref, lead_id, customer_name, status, deposit_amount, deposit_paid_at, balance_invoice_amount, agreed_price, grand_total",
      )
      .eq("status", "accepted")
      .order("id")
      .range(f, t),
  );
  const leadIds = [...new Set((quotes ?? []).map((q) => q.lead_id).filter(Boolean))] as string[];
  const { data: leads } = leadIds.length
    ? await sb.from("leads").select("id, balance_paid_at").in("id", leadIds)
    : { data: [] as { id: string; balance_paid_at: string | null }[] };
  const balancePaid = new Map((leads ?? []).map((l) => [l.id, l.balance_paid_at]));

  const items: OpenItem[] = [];
  for (const q of quotes ?? []) {
    const base = {
      quoteId: q.id as string,
      quoteRef: (q.quote_ref as string) ?? "",
      leadId: (q.lead_id as string | null) ?? null,
      customer: (q.customer_name as string | null) ?? null,
    };
    if (!base.quoteRef) continue;
    if (!q.deposit_paid_at && Number(q.deposit_amount) > 0) {
      items.push({ ...base, kind: "deposit", amount: Number(q.deposit_amount) });
    }
    if (q.deposit_paid_at && q.lead_id && !balancePaid.get(q.lead_id)) {
      const balance =
        Number(q.balance_invoice_amount) ||
        Math.max(0, Number(q.agreed_price ?? q.grand_total ?? 0) - Number(q.deposit_amount ?? 0));
      if (balance > 0) items.push({ ...base, kind: "balance", amount: balance });
    }
  }
  return items;
}

// Type alias (not interface) so it satisfies runCron's Record<string, unknown>.
export type BankFeedSyncSummary = {
  disabled?: boolean;
  rowsInSheet: number;
  upserted: number;
  suggested: number;
  unmatched: number;
};

export async function syncBankFeed(sb: SupabaseClient): Promise<BankFeedSyncSummary> {
  if (!bankFeedConfigured()) {
    return { disabled: true, rowsInSheet: 0, upserted: 0, suggested: 0, unmatched: 0 };
  }
  const rows = await fetchSheetRows();

  // Upsert base fields only — status/match columns belong to the matcher and
  // the office and must survive re-syncs (Monzo mutates recent rows).
  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({
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
    const { data, error } = await sb
      .from("bank_transactions")
      .upsert(chunk as never, { onConflict: "transaction_id", ignoreDuplicates: false })
      .select("id");
    if (error) throw new Error(`bank_transactions upsert failed: ${error.message}`);
    upserted += data?.length ?? 0;
  }

  // (Re)match every inbound row the office hasn't dealt with. Suggestions are
  // recomputed each pass so a newly-raised invoice can claim an older unmatched
  // transfer — but confirmed/dismissed rows are never touched.
  const open = await loadOpenItems(sb);
  // fetchAllRows, not a bare select — PostgREST caps at 1,000 rows and the
  // history import alone is ~1,900, so a bare select silently skips the
  // NEWEST rows (they insert last). Bit us on the very first live sync.
  const pending = await fetchAllRows((f, t) =>
    sb
      .from("bank_transactions")
      .select("id, amount, tx_type, reference, description, status, matched_quote_id, match_kind, match_confidence")
      .in("status", ["info", "unmatched", "suggested"])
      .order("id")
      .range(f, t),
  );

  let suggested = 0;
  let unmatched = 0;
  for (const row of pending ?? []) {
    const inbound = isInboundPayment({ amount: Number(row.amount), txType: row.tx_type as string | null });
    if (!inbound) continue; // stays info
    const m = matchTransaction(
      { amount: Number(row.amount), reference: row.reference as string | null, description: row.description as string | null },
      open,
    );
    const next = m
      ? {
          status: "suggested",
          matched_quote_id: m.quoteId,
          match_kind: m.kind,
          match_confidence: m.confidence,
        }
      : { status: "unmatched", matched_quote_id: null, match_kind: null, match_confidence: null };
    if (m) suggested++;
    else unmatched++;
    const changed =
      next.status !== row.status ||
      next.matched_quote_id !== (row.matched_quote_id ?? null) ||
      next.match_kind !== (row.match_kind ?? null) ||
      next.match_confidence !== (row.match_confidence ?? null);
    if (changed) {
      const { error } = await sb.from("bank_transactions").update(next as never).eq("id", row.id);
      if (error) throw new Error(`bank_transactions match update failed: ${error.message}`);
    }
  }

  return { rowsInSheet: rows.length, upserted, suggested, unmatched };
}
