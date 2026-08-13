import { describe, expect, it } from "vitest";
import { legacyLocked } from "@/lib/legacy";

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
});
