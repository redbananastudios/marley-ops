/**
 * Pure payment math + reference helpers for the accept/deposit/balance flow.
 * No IO — fully unit-tested (tests/lib/quote/payments.test.ts). Money rules
 * here are load-bearing: the two Zoho invoices (deposit + balance) must sum
 * exactly to the agreed price.
 */

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Zoho reference numbers — distinct per document so orphan-adoption after a
 *  crash can never confuse the deposit, commitment and balance invoices. */
export const depositReference = (quoteRef: string): string => `${quoteRef}-DEP`;
export const balanceReference = (quoteRef: string): string => `${quoteRef}-BAL`;
/** Payments Policy v2: the 25%-minus-deposit commitment invoice raised at
 *  date confirmation (docs/payments-policy-v2-prd.md). */
export const commitmentReference = (quoteRef: string): string => `${quoteRef}-COM`;

/** Balance due = agreed price minus the deposit, never negative. */
export function balanceDue(agreedPrice: number, depositAmount: number): number {
  return round2(Math.max(0, (agreedPrice || 0) - (depositAmount || 0)));
}

/** Accept links expire with the quote's 30-day validity (measured from when it
 *  was emailed, falling back to creation). */
export function acceptExpiresAt(emailSentAt: string | null, createdAt: string): Date {
  const base = new Date(emailSentAt ?? createdAt);
  return new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
}

export function isAcceptExpired(
  emailSentAt: string | null,
  createdAt: string,
  now: Date = new Date(),
): boolean {
  return now > acceptExpiresAt(emailSentAt, createdAt);
}

/** Customer-facing move-date label ("Monday 20 July") from the stored yyyy-mm-dd. */
export function moveDateLabel(movingDate: string | null | undefined): string | null {
  if (!movingDate) return null;
  const d = new Date(movingDate + (movingDate.length === 10 ? "T00:00:00" : ""));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  });
}

/** Balance chase due date (yyyy-mm-dd): the day before the move when the move
 *  date is known and still ahead, else `fallbackDays` from today. */
export function balanceDueDate(
  movingDate: string | null | undefined,
  today: Date = new Date(),
  fallbackDays = 3,
): string {
  const fallback = new Date(today.getTime() + fallbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (!movingDate || !/^\d{4}-\d{2}-\d{2}/.test(movingDate)) return fallback;
  const move = new Date(movingDate.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(move.getTime())) return fallback;
  const dayBefore = new Date(move.getTime() - 24 * 60 * 60 * 1000);
  return dayBefore.getTime() > today.getTime() ? dayBefore.toISOString().slice(0, 10) : fallback;
}
