/**
 * "I could not check" must never render as "nothing to report".
 *
 * A poller that reads external state reports two different things and they are
 * easy to conflate: how many rows it EXAMINED, and how many statuses it actually
 * READ. When the second number collapses to zero the first one carries on
 * looking healthy — `{checked: 25, settled: 0}` under a total outage is
 * byte-identical to a day on which nobody paid. Worse, `runCron` treats a
 * non-throwing sweep as a success and RESOLVES the job's operational issue, so
 * the run actively clears the one surface that would have shown the problem.
 *
 * This helper is the single definition of when a sweep learned nothing, shared
 * by every poller rather than re-implemented inline per route.
 *
 * It matters most at the ledger flip: an invoice id minted by one provider and
 * polled against another fails on every pass, forever. Without this the failure
 * is invisible, and the first evidence would be a customer who has already paid
 * receiving a chase.
 */

/**
 * Returns a `runCron`-shaped failure when a sweep could not complete a SINGLE
 * read, and `null` otherwise.
 *
 * Deliberate boundaries, both of which are the point rather than an oversight:
 *
 * - **Nothing to read is not blindness.** `attempted === 0` returns null. A
 *   sweep with no open invoices genuinely has nothing to say, and failing it
 *   would cry wolf on every quiet day until someone muted the alarm.
 * - **A partial failure is a visible COUNT, not a failed run.** One timeout in
 *   twenty-five is transient and the next pass retries it; failing the whole run
 *   would train everyone to ignore the alert, which costs more than it saves.
 *   Callers still surface `statusReads` / `statusReadFailures` in their summary,
 *   so a persistent partial failure is legible in `cron_runs` without an alarm.
 *
 * @param subject what was being read, for the operator reading the alert
 *                (e.g. "ledger status"), phrased as a noun.
 */
export function blindSweepFailure(
  subject: string,
  attempted: number,
  failed: number,
): { ok: false; error: string } | null {
  if (attempted <= 0 || failed < attempted) return null;
  return {
    ok: false,
    error:
      `every ${subject} read failed (${failed}/${attempted}) — this run reported no change because ` +
      `it could not CHECK anything, not because nothing changed`,
  };
}
