/**
 * Monzo Google-Sheets export → typed rows (pure, no I/O). The export's tab
 * "Business Account Transactions" carries these headers (verified against the
 * live sheet, 2026-07-16):
 *
 *   Transaction ID · Date · Time · Type · Name · Emoji · Category · Amount ·
 *   Currency · Local amount · Local currency · Notes and #tags · Address ·
 *   Receipt · Description · Category split · Pot name
 *
 * Columns are mapped BY HEADER NAME; if any LOAD-BEARING header disappears
 * (id/date/amount, but also Type and Notes — a rename would silently kill
 * classification/matching), parsing REFUSES entirely so the cron run fails
 * loudly and the watchdog pages, rather than degrading in silence.
 *
 * Rows the parser can't trust (bad date, unparseable amount) are SKIPPED and
 * COUNTED — the skip count rides the cron summary so dropped money rows are
 * visible on /automations instead of vanishing.
 */

export const BANK_FEED_TAB = "Business Account Transactions";

export interface BankTxRow {
  transactionId: string;
  /** ISO yyyy-mm-dd (Monzo exports UK wall-clock dates). */
  txDate: string;
  txTime: string | null;
  txType: string | null;
  counterparty: string | null;
  amount: number;
  currency: string | null;
  /** "Notes and #tags" — the reference field. */
  reference: string | null;
  description: string | null;
  raw: Record<string, string>;
}

export interface ParsedSheet {
  rows: BankTxRow[];
  /** Rows carrying a transaction id that we could not safely ingest. */
  skipped: number;
}

/** DD/MM/YYYY → yyyy-mm-dd, with a component ROUND-TRIP (Date.parse rolls
 *  impossible dates like 31/02 over to March instead of rejecting them — the
 *  same pattern as ukDayWindow in lib/payments/received.ts). One poison date
 *  reaching the `date` column would fail the whole upsert chunk forever. */
export function ukDateToIso(d: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((d ?? "").trim());
  if (!m) return null;
  const [dd, mm, yyyy] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yyyy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Amounts defensively: the Sheets fetch asks for UNFORMATTED_VALUE, but if
 *  formatting ever leaks through anyway ("£1,020.00"), strip it rather than
 *  silently dropping the biggest (comma-bearing) money rows. */
export function parseAmount(v: string | number | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const cleaned = (v ?? "").replace(/[£$€,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

type Cell = string | number | undefined;

/**
 * Sheet values (first row = headers) → typed rows + a skipped count. Refuses
 * entirely (empty result, zero skip — the caller treats an empty sheet with
 * rows as schema drift) if load-bearing headers are missing.
 */
export function parseSheetRows(values: Cell[][]): ParsedSheet {
  if (!values.length) return { rows: [], skipped: 0 };
  const headers = values[0].map((h) => String(h ?? "").trim());
  const col = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iId = col("Transaction ID");
  const iDate = col("Date");
  const iTime = col("Time");
  const iType = col("Type");
  const iName = col("Name");
  const iAmount = col("Amount");
  const iCurrency = col("Currency");
  const iNotes = col("Notes and #tags");
  const iDesc = col("Description");
  // Type + Notes are load-bearing too: without Type nothing classifies as
  // inbound; without Notes references stop matching. Refuse loudly.
  if (iId < 0 || iDate < 0 || iAmount < 0 || iType < 0 || iNotes < 0) {
    throw new Error(
      `Bank-feed sheet schema drift: missing header(s) ${[
        iId < 0 ? "Transaction ID" : null,
        iDate < 0 ? "Date" : null,
        iAmount < 0 ? "Amount" : null,
        iType < 0 ? "Type" : null,
        iNotes < 0 ? "Notes and #tags" : null,
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  }

  const rows: BankTxRow[] = [];
  let skipped = 0;
  for (const row of values.slice(1)) {
    const get = (i: number): string => (i >= 0 ? String(row[i] ?? "").trim() : "");
    const transactionId = get(iId);
    if (!transactionId) continue; // blank spacer rows aren't data loss
    const txDate = ukDateToIso(get(iDate));
    const amount = parseAmount(row[iAmount] as Cell);
    if (!txDate || amount === null) {
      skipped++;
      continue;
    }
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = String(row[i] ?? "").trim();
      if (h && v) raw[h] = v;
    });
    rows.push({
      transactionId,
      txDate,
      txTime: get(iTime) || null,
      txType: get(iType) || null,
      counterparty: get(iName) || null,
      amount,
      currency: get(iCurrency) || null,
      reference: get(iNotes) || null,
      description: get(iDesc) || null,
      raw,
    });
  }
  return { rows, skipped };
}

/** Inbound customer money = positive faster payment / BACS credit / Monzo-to-
 *  Monzo transfer (customers who bank with Monzo arrive as that type — proven
 *  by the very first live test transfer, 2026-07-16). Pot transfers, card
 *  settlements and outbound payments are bookkeeping noise. */
export function isInboundPayment(tx: Pick<BankTxRow, "amount" | "txType">): boolean {
  if (tx.amount <= 0) return false;
  const t = (tx.txType ?? "").toLowerCase();
  return t.includes("faster payment") || t.includes("bacs") || t.includes("monzo-to-monzo");
}
