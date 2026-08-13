/**
 * T-7 automatic final (balance) invoice — candidate selection.
 *
 * Final invoices were manual-only (the button on the booking's payments card),
 * which is how Brydee Thomas (MMR034) reached her move day with hers never
 * raised: nothing forced the click before the move, and the post-move alarm
 * only speaks after it is too late to be paperwork. From T-7 the balance is
 * real and expected, so the chase cron raises + emails it automatically via
 * createBalanceInvoiceFlow — already CAS-guarded and Zoho-orphan safe: an
 * invoice Connor raised by hand at a different figure refuses and alerts
 * rather than double-billing.
 *
 * Pure so the rules are unit-testable away from the route.
 */
import { legacyLocked, type LegacyLockFields } from "@/lib/legacy";

export interface BalanceInvoiceQuote extends LegacyLockFields {
  status: string;
  moving_date: string | null;
  zoho_balance_invoice_id: string | null;
  booking_cancelled_at: string | null;
}

export interface BalanceInvoiceLead {
  status: string;
  balance_paid_at: string | null;
}

/** Move date sits between today and T+7 inclusive (UK day keys, YYYY-MM-DD). */
export const withinT7Window = (movingDate: string | null, todayDay: string, t7Day: string): boolean =>
  !!movingDate && movingDate >= todayDay && movingDate <= t7Day;

export function balanceInvoiceDue(
  quote: BalanceInvoiceQuote,
  lead: BalanceInvoiceLead | undefined,
  todayDay: string,
  t7Day: string,
): boolean {
  if (quote.status !== "accepted") return false;
  if (quote.booking_cancelled_at) return false;
  // Already raised — or mid-raise: the flow CAS-claims the column with
  // 'pending', and either way this cron must not touch it again.
  if (quote.zoho_balance_invoice_id) return false;
  // Legacy iMVE bookings stay silent until the office has informed the
  // customer by phone (standard_comms_at — Luke's T-8/9 call).
  if (legacyLocked(quote)) return false;
  if (!withinT7Window(quote.moving_date, todayDay, t7Day)) return false;
  if (!lead || lead.status !== "confirmed") return false;
  // Settled jobs have nothing left to bill — skip rather than let the flow
  // discover it and log a daily "Nothing left to invoice" refusal.
  if (lead.balance_paid_at) return false;
  return true;
}
