/**
 * When automated CHASES and NUDGES are allowed to reach a customer.
 *
 * The VPS clock is Etc/UTC and the chase cron was a fixed `0 9 * * *`, so chases
 * actually landed at 10:00 UK through BST and 09:00 through GMT — the send time
 * drifted by an hour twice a year with nothing to show why. Worse, any manual
 * run of the cron fired real chases at whatever time it happened to be (two went
 * out at 17:01 on 2026-08-10).
 *
 * The fix follows the pattern `lib/crew-sheet/dispatch.ts` already uses for its
 * 19:30 UK send: the cron fires at BOTH 08:00 and 09:00 UTC and the app decides
 * which one is really 09:00 in London. Exactly one passes all year — in BST
 * 08:00 UTC is 09:00 UK and 09:00 UTC is 10:00 UK; in GMT the reverse. No
 * seasonal crontab maintenance, and no trust placed in the box's clock.
 *
 * Scope is deliberately narrow (Peter, 2026-08-10: "chases and nudges only").
 * Payment receipts, quote sends, booking and reschedule notices, and anything a
 * human clicks all stay immediate — a customer who pays at 11pm should get their
 * confirmation at 11pm, not at nine the next morning.
 */

import { ukParts } from "@/lib/uk-time";

/** 09:00 UK, every day — Peter, 2026-08-10. */
export const SEND_HOUR_UK = 9;

/**
 * True during the 09:00 UK hour. An hour-wide window, not an instant, because
 * the cron fires on the hour and a slow run must not miss its own slot.
 */
export function isCustomerSendHour(now: Date = new Date()): boolean {
  return ukParts(now).hour === SEND_HOUR_UK;
}

/** For the run summary — says WHY a run sent nothing, so a gated run reads
 *  differently from a genuinely quiet one. */
export function sendWindowReason(now: Date = new Date()): string {
  const { hour } = ukParts(now);
  return `outside the ${SEND_HOUR_UK}:00 UK send window (it is ${String(hour).padStart(2, "0")}:xx UK)`;
}
