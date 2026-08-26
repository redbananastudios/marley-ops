import { describe, expect, it } from "vitest";

import { blindSweepFailure } from "@/lib/cron/blind-sweep";

/**
 * The rule this pins: a poller that could not reach the thing it polls must
 * report a FAILED run, never a quiet success. `runCron` resolves the job's
 * operational issue on any non-throwing sweep, so a swallowed outage does not
 * merely go unreported — it actively clears the alarm that would have shown it.
 *
 * The two boundaries below are the whole design, and both are easy to get
 * backwards.
 */
describe("blindSweepFailure", () => {
  it("fails the run when every read failed", () => {
    const f = blindSweepFailure("ledger status", 25, 25);
    expect(f).not.toBeNull();
    expect(f?.ok).toBe(false);
    expect(f?.error).toContain("25/25");
  });

  it("fails on a single attempted read that failed", () => {
    expect(blindSweepFailure("ledger status", 1, 1)?.ok).toBe(false);
  });

  /**
   * Nothing to read is not blindness. A sweep with no open invoices genuinely
   * has nothing to say; failing it would cry wolf every quiet day until someone
   * muted the alarm, which is how you lose the signal for real.
   */
  it("does NOT fail when there was nothing to read", () => {
    expect(blindSweepFailure("ledger status", 0, 0)).toBeNull();
  });

  /**
   * A partial failure is a visible count, not a failed run. One timeout in
   * twenty-five is transient and the next pass retries it. The caller still
   * surfaces statusReads/statusReadFailures, so a persistent partial stays
   * legible in cron_runs without an alarm nobody would trust.
   */
  it("does NOT fail on a partial failure", () => {
    expect(blindSweepFailure("ledger status", 25, 24)).toBeNull();
    expect(blindSweepFailure("ledger status", 25, 1)).toBeNull();
    expect(blindSweepFailure("ledger status", 25, 0)).toBeNull();
  });

  /**
   * The message has to say WHY there is no change, because "settled: 0" is the
   * same number on a healthy quiet day. An operator reading the alert at 3am
   * needs the distinction in the sentence, not in their head.
   */
  it("says the run could not check, not that nothing changed", () => {
    const err = blindSweepFailure("ledger status", 3, 3)!.error;
    expect(err).toMatch(/could not CHECK anything/);
    expect(err).toMatch(/not because nothing changed/);
    expect(err).toContain("ledger status");
  });

  it("names the subject it was asked about", () => {
    expect(blindSweepFailure("storage invoice status", 4, 4)?.error).toContain("storage invoice status");
  });

  /** Defensive: a miscount must not silently invent a failure. */
  it("treats impossible counts as not blind rather than guessing", () => {
    expect(blindSweepFailure("ledger status", -1, 5)).toBeNull();
    expect(blindSweepFailure("ledger status", 0, 3)).toBeNull();
  });
});
