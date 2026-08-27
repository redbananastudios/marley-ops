import { describe, expect, it } from "vitest";

import { LedgerError } from "@/lib/ledger";
import { assertWritable, isDemoOrg, liveWritesAllowed } from "@/lib/ledger/xero-guard";

/**
 * Peter, 2026-08-27: *"the Live Xero is live so do not work on that or make any
 * changes there — it is read only until we have fully switched."*
 *
 * These tests are that instruction, written down where it cannot be forgotten.
 * The asymmetry they encode is the whole design: a Demo Company that briefly
 * refuses a write costs a retry; a live organisation that briefly allows one
 * costs an accountant a reversing journal entry with a VAT period attached.
 */

const demo = { class: "DEMO", name: "Demo Company (UK)" };
const live = { class: "COMPANY", name: "MarleyMoves Ltd" };
const empty = {};

describe("assertWritable — the default is refuse", () => {
  it("allows a write to a Demo Company", () => {
    expect(() => assertWritable(demo, "create an invoice", empty)).not.toThrow();
  });

  it("refuses a write to a live organisation", () => {
    expect(() => assertWritable(live, "create an invoice", empty)).toThrow(LedgerError);
    expect(() => assertWritable(live, "create an invoice", empty)).toThrow(/READ-ONLY until the cutover/);
  });

  /**
   * The failure mode that matters most. An org whose class could not be read is
   * treated as LIVE — "I could not check" must never render as "safe to write".
   */
  it("refuses when the class could not be read at all", () => {
    expect(() => assertWritable({ class: null }, "record a payment", empty)).toThrow(LedgerError);
    expect(() => assertWritable(null, "record a payment", empty)).toThrow(/could not be read/);
    expect(() => assertWritable(undefined, "record a payment", empty)).toThrow(LedgerError);
  });

  it("names the operation it refused, so an ops alert says what did not happen", () => {
    expect(() => assertWritable(live, "void invoice INV-0042", empty)).toThrow(/void invoice INV-0042/);
  });

  it("names the organisation it refused", () => {
    expect(() => assertWritable(live, "x", empty)).toThrow(/MarleyMoves Ltd/);
  });
});

describe("assertWritable — the explicit unlock", () => {
  it("allows a live write only when the flag is exactly true", () => {
    expect(() =>
      assertWritable(live, "create an invoice", { XERO_ALLOW_LIVE_WRITES: "true" }),
    ).not.toThrow();
  });

  /**
   * A flag that is present but not `true` is not an unlock. `"false"`, `"1"`,
   * `"yes"` and an empty string all mean the switch was not thrown — anything
   * looser turns a stray variable into permission to write to live books.
   */
  it("treats every near-miss value as NOT set", () => {
    for (const v of ["false", "1", "yes", "TRUE ", "", " ", "no", "0"]) {
      const env = { XERO_ALLOW_LIVE_WRITES: v };
      if (v.trim().toLowerCase() === "true") continue; // "TRUE " is trimmed+lowered — allowed
      expect(() => assertWritable(live, "create an invoice", env), `value ${JSON.stringify(v)}`).toThrow();
    }
  });

  it("accepts the flag case- and whitespace-insensitively, since a human types it", () => {
    expect(liveWritesAllowed({ XERO_ALLOW_LIVE_WRITES: " TRUE " })).toBe(true);
    expect(liveWritesAllowed({ XERO_ALLOW_LIVE_WRITES: "True" })).toBe(true);
  });

  it("is not set when the variable is absent", () => {
    expect(liveWritesAllowed(empty)).toBe(false);
  });
});

describe("isDemoOrg", () => {
  it("recognises the demo class regardless of case or padding", () => {
    expect(isDemoOrg({ class: "DEMO" })).toBe(true);
    expect(isDemoOrg({ class: " demo " })).toBe(true);
  });

  /**
   * Everything that is not provably DEMO is not demo. Listed explicitly because
   * a future Xero class value must fail SAFE — refused, not assumed harmless.
   */
  it("treats anything else as not-demo, including unknown values", () => {
    for (const c of ["COMPANY", "TRIAL", "PARTNER", "STARTER", "", "SOMETHING_NEW"]) {
      expect(isDemoOrg({ class: c }), `class ${c}`).toBe(false);
    }
    expect(isDemoOrg({ class: null })).toBe(false);
    expect(isDemoOrg(null)).toBe(false);
  });
});

/**
 * Two independent demo signals, added after the research pass found that Xero
 * publishes `IsDemoCompany` alongside `Class` — and that nothing guarantees the
 * two always agree. For a decision that gates writes to a real accounting
 * ledger, two signals that must not contradict each other beat one that is
 * probably right.
 */
describe("isDemoOrg — the second signal", () => {
  it("is demo when both signals agree", () => {
    expect(isDemoOrg({ class: "DEMO", isDemoCompany: true })).toBe(true);
  });

  /**
   * The veto. Two fields describing the same fact and disagreeing means we do
   * not know which books these are — and "we do not know" is not a state in
   * which to write to an accounting ledger.
   */
  it("refuses a DEMO class that IsDemoCompany explicitly contradicts", () => {
    expect(isDemoOrg({ class: "DEMO", isDemoCompany: false })).toBe(false);
  });

  /**
   * Absence is not contradiction. Vetoing on a missing field would break
   * staging the day Xero trims one from a response — a real cost against a
   * hypothetical gain.
   */
  it("still trusts a DEMO class when the second signal is simply absent", () => {
    expect(isDemoOrg({ class: "DEMO" })).toBe(true);
    expect(isDemoOrg({ class: "DEMO", isDemoCompany: null })).toBe(true);
  });

  /** IsDemoCompany alone never promotes a live org. Class is decisive. */
  it("never treats a live class as demo, whatever the second signal says", () => {
    expect(isDemoOrg({ class: "STANDARD", isDemoCompany: true })).toBe(false);
    expect(isDemoOrg({ class: "PREMIUM", isDemoCompany: true })).toBe(false);
    expect(isDemoOrg({ class: null, isDemoCompany: true })).toBe(false);
  });

  it("keeps writes refused when the signals disagree", () => {
    expect(() => assertWritable({ class: "DEMO", isDemoCompany: false }, "create an invoice", empty)).toThrow(
      LedgerError,
    );
  });
});
