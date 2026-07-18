import { describe, it, expect } from "vitest";
import {
  CONTRACTOR_ACKS,
  CONTRACTOR_AGREEMENT_VERSION,
  allContractorAcksConfirmed,
  normalizeContractorAcks,
} from "@/lib/contractor/agreement";

const ALL_TRUE = Object.fromEntries(CONTRACTOR_ACKS.map((a) => [a.key, true]));

describe("allContractorAcksConfirmed", () => {
  it("is false for null/undefined/empty", () => {
    expect(allContractorAcksConfirmed(null)).toBe(false);
    expect(allContractorAcksConfirmed(undefined)).toBe(false);
    expect(allContractorAcksConfirmed({})).toBe(false);
  });

  it("is false if any single ack is missing or false", () => {
    for (const a of CONTRACTOR_ACKS) {
      const partial = { ...ALL_TRUE, [a.key]: false };
      expect(allContractorAcksConfirmed(partial)).toBe(false);
    }
  });

  it("is true only when every ack is exactly true", () => {
    expect(allContractorAcksConfirmed(ALL_TRUE)).toBe(true);
  });

  it("treats non-true truthy values as not confirmed", () => {
    const coerced = Object.fromEntries(CONTRACTOR_ACKS.map((a) => [a.key, 1 as unknown as boolean]));
    expect(allContractorAcksConfirmed(coerced)).toBe(false);
  });
});

describe("normalizeContractorAcks", () => {
  it("returns exactly the known keys as booleans", () => {
    const out = normalizeContractorAcks(ALL_TRUE);
    expect(Object.keys(out).sort()).toEqual(CONTRACTOR_ACKS.map((a) => a.key).sort());
    expect(Object.values(out).every((v) => v === true)).toBe(true);
  });

  it("drops unknown keys and coerces missing to false", () => {
    const out = normalizeContractorAcks({ bogus: true } as Record<string, boolean>);
    expect("bogus" in out).toBe(false);
    expect(Object.values(out).every((v) => v === false)).toBe(true);
  });

  it("only true stays true", () => {
    const first = CONTRACTOR_ACKS[0].key;
    const out = normalizeContractorAcks({ [first]: "yes" as unknown as boolean });
    expect(out[first]).toBe(false);
  });
});

describe("CONTRACTOR_AGREEMENT_VERSION", () => {
  it("is a non-empty stable string", () => {
    expect(typeof CONTRACTOR_AGREEMENT_VERSION).toBe("string");
    expect(CONTRACTOR_AGREEMENT_VERSION.length).toBeGreaterThan(0);
  });
});
