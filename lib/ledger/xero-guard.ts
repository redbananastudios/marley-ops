/**
 * The live-books write guard — SERVER ONLY.
 *
 * Peter, 2026-08-27, handing over the Xero credentials: *"the Live Xero is live
 * so do not work on that or make any changes there — it is read only until we
 * have fully switched."*
 *
 * That instruction is not kept by remembering it. It is kept here, because the
 * thing it protects is Connor's real books during the weeks when the Zoho→Xero
 * cutover is still being built and tested, and a single stray write into a live
 * accounting ledger is not something a revert undoes — it is a journal entry an
 * accountant has to reverse, with a VAT period attached.
 *
 * ## The rule
 *
 * Every WRITE refuses unless one of two things is true:
 *
 *  1. the connected organisation reports `Class === "DEMO"` — the Xero Demo
 *     Company, which is what staging talks to; or
 *  2. `XERO_ALLOW_LIVE_WRITES=true` is explicitly set in the environment.
 *
 * READS are never gated. Reading the live org is exactly what "read only until
 * we have fully switched" permits, and it is how the history snapshot and every
 * verification step work.
 *
 * ## Why the default is deny rather than allow
 *
 * The alternative shape — a `XERO_READONLY=true` flag on production — is one
 * forgotten variable away from writing to live, and the forgetting is silent.
 * This way the dangerous state has to be typed out on purpose. Setting that flag
 * IS the switch Peter described, and it is a deliberate act on one machine, in
 * the same edit as `LEDGER_PROVIDER=xero`.
 *
 * ## Why the org class and not the credentials
 *
 * The staging credentials are physically separate from the live ones and the
 * live pair is deliberately absent from this machine, so in practice a dev
 * container cannot reach the real books at all. But "in practice" is a property
 * of file placement, and file placement is not enforcement — someone testing a
 * cutover will eventually paste the live pair somewhere to see if it works. The
 * class check holds even then, because it asks the organisation itself what it
 * is rather than trusting how we got there.
 *
 * ## Why it fails closed on an unreadable class
 *
 * An organisation whose class cannot be determined is treated as LIVE, not as
 * demo. "I could not check" must never render as "safe to write" — the same
 * rule the payment pollers were fixed under. A Demo Company that briefly refuses
 * writes costs a retry; a live org that briefly allows them costs an accountant.
 */
import { LedgerError } from "./types";

/** Just enough of an environment to read a flag from — `NodeJS.ProcessEnv`
 *  would force every test fixture to carry NODE_ENV for no benefit. */
type EnvLike = Record<string, string | undefined>;

/** Xero's `Organisation.Class` value for a Demo Company. */
export const DEMO_CLASS = "DEMO";

/** The explicit unlock. Setting this is the cutover, not a convenience. */
export const LIVE_WRITE_FLAG = "XERO_ALLOW_LIVE_WRITES";

export interface XeroOrgIdentity {
  /** `Organisation.Class`, verbatim. Null when it could not be read. */
  class: string | null;
  /**
   * `Organisation.IsDemoCompany` — a SECOND, independent statement about the
   * same question. Null when the field was absent from the response.
   *
   * Xero documents both fields and its own samples agree, but nothing
   * guarantees they always will. For a decision this consequential, two signals
   * that must not contradict each other is worth more than one that is probably
   * right.
   */
  isDemoCompany?: boolean | null;
  /** For the error message — which org was refused. */
  name?: string | null;
}

/** True only for an explicit, exact `true`. Any other value is not an unlock. */
export function liveWritesAllowed(env: EnvLike = process.env): boolean {
  return (env[LIVE_WRITE_FLAG] ?? "").trim().toLowerCase() === "true";
}

/**
 * True when the organisation is provably a Xero Demo Company.
 *
 * Two signals, and they may not disagree. `Class` must say `DEMO`, and
 * `IsDemoCompany` must not say `false`.
 *
 * The asymmetry between the two conditions is deliberate:
 *
 * - `Class !== "DEMO"` is decisive on its own. `Class` has 23 documented
 *   values and only one of them is the demo.
 * - `IsDemoCompany === false` **vetoes** a `DEMO` class. Two fields describing
 *   the same fact and contradicting each other means we do not actually know
 *   which set of books this is, and "we do not know" is not a state in which to
 *   write to an accounting ledger.
 * - `IsDemoCompany` **absent** does not veto. Absence is not contradiction, and
 *   refusing on it would break staging the day Xero trims a field from a
 *   response — a real cost against a hypothetical gain.
 *
 * That last clause is load-bearing, not defensive padding. The adversarial pass
 * that recommended composing the two signals also warned that the ONLY official
 * evidence a Demo Company returns `IsDemoCompany: true` is a single sample
 * response on Xero's organisation page — so a strict AND could refuse every
 * staging write and look like a broken integration rather than a guard working.
 * Treating absence as silence rather than denial keeps the safety property
 * (a live org still cannot write) without that failure mode.
 *
 * Verify both fields on the first real read against the Demo Company anyway.
 * Nothing here has been confirmed against a live Xero response yet.
 */
export function isDemoOrg(org: XeroOrgIdentity | null | undefined): boolean {
  if ((org?.class ?? "").trim().toUpperCase() !== DEMO_CLASS) return false;
  return org?.isDemoCompany !== false;
}

/**
 * Throw unless a write is permitted against `org`.
 *
 * @param operation what was being attempted, so the refusal names it — an
 *                  operator reading an ops alert needs to know what did not
 *                  happen, not merely that something did not.
 */
export function assertWritable(
  org: XeroOrgIdentity | null | undefined,
  operation: string,
  env: EnvLike = process.env,
): void {
  if (isDemoOrg(org)) return;
  if (liveWritesAllowed(env)) return;

  const which = org?.name ? `"${org.name}"` : "the connected organisation";
  const cls = org?.class ? `Class=${org.class}` : "its class could not be read";
  throw new LedgerError(
    `Refusing to ${operation} in Xero: ${which} is not a Demo Company (${cls}), and ` +
      `${LIVE_WRITE_FLAG} is not set. The live Xero organisation is READ-ONLY until the ` +
      `cutover — reads are fine, writes are not. If this is the cutover, set ` +
      `${LIVE_WRITE_FLAG}=true deliberately, in the same edit as LEDGER_PROVIDER=xero.`,
  );
}
