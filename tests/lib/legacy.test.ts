import { describe, expect, it } from "vitest";
import { IMPORTED_SOURCES, importedBooking, legacyLocked } from "@/lib/legacy";

describe("legacyLocked", () => {
  it("locks an imve quote with no standard-comms stamp", () => {
    expect(legacyLocked({ source: "imve", standard_comms_at: null })).toBe(true);
  });

  it("unlocks an imve quote once the office has recorded the phone call", () => {
    expect(legacyLocked({ source: "imve", standard_comms_at: "2026-08-19T09:00:00Z" })).toBe(false);
  });

  it("never locks a normal marley_ops quote, stamped or not", () => {
    expect(legacyLocked({ source: "marley_ops", standard_comms_at: null })).toBe(false);
    expect(legacyLocked({ source: "marley_ops", standard_comms_at: "2026-08-19T09:00:00Z" })).toBe(false);
  });

  it("never locks a null-source quote (pre-0088 rows)", () => {
    expect(legacyLocked({ source: null, standard_comms_at: null })).toBe(false);
  });

  // Gate 20. A Pitmans forward booking was sold by Mark, under his terms, to a
  // customer who has never heard from Marley. Every automated money and comms
  // rail funnels through this one predicate (balance-invoice-due, late-balance,
  // pay-in-full, payment-link, the chase cron, accept-flow), so this is the
  // assertion that stops the first contact from the new owner being an
  // automated payment demand.
  it("locks a pitmans import with no standard-comms stamp", () => {
    expect(legacyLocked({ source: "pitmans", standard_comms_at: null })).toBe(true);
  });

  it("unlocks a pitmans import once the office has recorded the phone call", () => {
    expect(legacyLocked({ source: "pitmans", standard_comms_at: "2026-09-22T09:00:00Z" })).toBe(false);
  });

  it("locks every imported source, so adding one to the list is all it takes", () => {
    for (const source of IMPORTED_SOURCES) {
      expect(legacyLocked({ source, standard_comms_at: null })).toBe(true);
    }
  });
});

describe("importedBooking", () => {
  it("is true for every imported source", () => {
    expect(importedBooking("imve")).toBe(true);
    expect(importedBooking("pitmans")).toBe(true);
  });

  it("is false for ordinary and unknown sources", () => {
    expect(importedBooking("marley_ops")).toBe(false);
    expect(importedBooking(null)).toBe(false);
    expect(importedBooking("website")).toBe(false);
  });

  // The whole reason this is a SEPARATE predicate from legacyLocked. The
  // office phoning a customer about their move does not retroactively create a
  // signed Marley contract for the crew to collect, so paperwork surfaces must
  // keep suppressing after the comms lock lifts.
  it("stays true after standard_comms_at lifts the comms lock", () => {
    const stamped = { source: "pitmans", standard_comms_at: "2026-09-22T09:00:00Z" };
    expect(legacyLocked(stamped)).toBe(false);
    expect(importedBooking(stamped.source)).toBe(true);
  });
});
