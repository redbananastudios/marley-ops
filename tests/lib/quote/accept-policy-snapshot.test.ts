import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source guard over the gate 8 acceptance snapshot.
 *
 * `payment_policy` is written into the same UPDATE that marks a quote accepted,
 * and there are TWO of those: the customer accepting at `/q`, and the office
 * accepting on their behalf. Both paths, one column.
 *
 * A snapshot written on only one path is worse than no snapshot at all. The
 * rows it misses come back null, `policyOfQuote` reads null as residential, and
 * a genuinely commercial booking is therefore indistinguishable from a
 * genuinely residential one — so gate 10 would put it on the deposit ladder and
 * chase a customer who was promised terms. Nothing would error; the only symptom
 * is a company being asked for a deposit.
 *
 * Unit tests cannot see that: they cover the pure resolver, and the resolver
 * would be perfectly correct while a call site quietly failed to use it. This is
 * the same shape as the gate 18 provider-stamp guard — the defect there was also
 * a correct helper that one of three call sites did not pass. So COUNT the
 * wiring rather than trusting an eyeball over a 1,000-line file.
 */
const SRC = readFileSync(join(process.cwd(), "lib/quote/accept-flow.ts"), "utf8");

/** The two `status: "accepted"` writes — the office one and the customer one. */
const ACCEPT_WRITES = SRC.split(/status: "accepted",/).length - 1;

describe("gate 8 — the payment policy is snapshotted on EVERY accept path", () => {
  it("still has exactly the two acceptance writes this guard was calibrated against", () => {
    // If a third accept path is ever added, this fails first and tells whoever
    // added it to snapshot the policy there too — rather than the guard below
    // silently continuing to pass while covering two paths out of three.
    expect(ACCEPT_WRITES).toBe(2);
  });

  it("writes payment_policy in as many places as it marks a quote accepted", () => {
    const policyWrites = SRC.split(/payment_policy: paymentPolicy,/).length - 1;
    expect(policyWrites).toBe(ACCEPT_WRITES);
  });

  it("resolves the snapshot through the shared helper, never inline", () => {
    // Two call sites, one helper. An inline `is_company` read at a call site
    // would bypass the unreadable-client logging and the lead fallback.
    const calls = SRC.split(/await snapshotPaymentPolicy\(/).length - 1;
    expect(calls).toBe(ACCEPT_WRITES);
  });

  it("reads the flag through resolvePaymentPolicy rather than testing is_company by hand", () => {
    expect(SRC).toContain("resolvePaymentPolicy(data)");
    // A hand-rolled truthiness test is the bug resolvePaymentPolicy's own tests
    // rule out (a stringly-typed "false" is truthy); it must not reappear here.
    expect(SRC).not.toMatch(/payment_policy:\s*\w+\.is_company/);
  });
});
