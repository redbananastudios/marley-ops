/**
 * Monzo Google-Sheets export → typed rows (pure, no I/O). The export's tab
 * "Business Account Transactions" carries these headers (verified against the
 * live sheet, 2026-07-16):
 *
 *   Transaction ID · Date · Time · Type · Name · Emoji · Category · Amount ·
 *   Currency · Local amount · Local currency · Notes and #tags · Address ·
 *   Receipt · Description · Category split · Pot name
 *
 * Columns are mapped BY HEADER NAME (Monzo may add/move columns), dates are
 * DD/MM/YYYY, amounts are signed decimals (income positive). The sender's
 * payment reference for an inbound Faster Payment lands in "Notes and #tags"
 * and usually repeats inside "Description".
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

/** DD/MM/YYYY → yyyy-mm-dd (null if malformed). */
export function ukDateToIso(d: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((d ?? "").trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/**
 * Sheet values (first row = headers) → typed rows. Rows without a transaction
 * id, parseable date or numeric amount are skipped — the sheet is a consumer
 * export, never trust a row shape.
 */
export function parseSheetRows(values: string[][]): BankTxRow[] {
  if (!values.length) return [];
  const headers = values[0].map((h) => (h ?? "").trim());
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
  if (iId < 0 || iDate < 0 || iAmount < 0) return []; // schema drifted — refuse rather than mis-ingest

  const out: BankTxRow[] = [];
  for (const row of values.slice(1)) {
    const get = (i: number): string => (i >= 0 ? ((row[i] ?? "") as string).trim() : "");
    const transactionId = get(iId);
    const txDate = ukDateToIso(get(iDate));
    const amount = Number(get(iAmount));
    if (!transactionId || !txDate || !Number.isFinite(amount)) continue;
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = ((row[i] ?? "") as string).trim();
      if (h && v) raw[h] = v;
    });
    out.push({
      transactionId,
      txDate,
      txTime: get(iTime) || null,
      txType: get(iType) || null,
      counterparty: get(iName) || null,
      amount: Math.round(amount * 100) / 100,
      currency: get(iCurrency) || null,
      reference: get(iNotes) || null,
      description: get(iDesc) || null,
      raw,
    });
  }
  return out;
}

/** Inbound customer money = positive faster payment / BACS credit. Pot
 *  transfers, card settlements and outbound payments are bookkeeping noise. */
export function isInboundPayment(tx: Pick<BankTxRow, "amount" | "txType">): boolean {
  if (tx.amount <= 0) return false;
  const t = (tx.txType ?? "").toLowerCase();
  return t.includes("faster payment") || t.includes("bacs");
}
