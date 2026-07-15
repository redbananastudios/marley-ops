import { describe, expect, it } from "vitest";
import { endpointHash, resolvePushRecipients } from "@/lib/push/send";
import { classifyPushError } from "@/lib/push/transport";

const OFFICE = [
  { id: "admin-1", role: "admin", active: true },
  { id: "est-1", role: "estimator", active: true },
  { id: "est-2", role: "estimator", active: true },
  { id: "crew-1", role: "crew", active: true },
  { id: "admin-2", role: "admin", active: false },
];

const noPrefs = new Map<string, Record<string, unknown>>();

describe("resolvePushRecipients", () => {
  it("selects active office users only — crew and inactive never receive", () => {
    const ids = resolvePushRecipients("new_enquiry", OFFICE, noPrefs, null);
    expect(ids.sort()).toEqual(["admin-1", "est-1", "est-2"]);
  });

  it("excludes the actor (never notify someone about their own action)", () => {
    const ids = resolvePushRecipients("payment_event", OFFICE, noPrefs, "est-1");
    expect(ids).not.toContain("est-1");
    expect(ids.sort()).toEqual(["admin-1", "est-2"]);
  });

  it("respects an explicit category opt-out", () => {
    const prefs = new Map<string, Record<string, unknown>>([
      ["est-1", { new_enquiry: false }],
      ["est-2", { payment_event: false }], // different category — no effect here
    ]);
    const ids = resolvePushRecipients("new_enquiry", OFFICE, prefs, null);
    expect(ids.sort()).toEqual(["admin-1", "est-2"]);
  });

  it("missing preference keys fall back to the category default (enabled)", () => {
    const prefs = new Map<string, Record<string, unknown>>([["admin-1", {}]]);
    const ids = resolvePushRecipients("payment_event", OFFICE, prefs, null);
    expect(ids).toContain("admin-1");
  });

  it("ignores non-boolean junk in stored preferences", () => {
    const prefs = new Map<string, Record<string, unknown>>([["admin-1", { new_enquiry: "no" }]]);
    const ids = resolvePushRecipients("new_enquiry", OFFICE, prefs, null);
    expect(ids).toContain("admin-1");
  });

  it("crew_job reaches crew only — office roles are excluded even when targeted", () => {
    const ids = resolvePushRecipients("crew_job", OFFICE, noPrefs, null);
    expect(ids).toEqual(["crew-1"]);
  });

  it("crew can opt out of job alerts", () => {
    const prefs = new Map<string, Record<string, unknown>>([["crew-1", { crew_job: false }]]);
    expect(resolvePushRecipients("crew_job", OFFICE, prefs, null)).toEqual([]);
  });
});

describe("classifyPushError (PRD §12.2)", () => {
  it("404/410 are permanent subscription-gone → prune", () => {
    expect(classifyPushError(404)).toBe("gone");
    expect(classifyPushError(410)).toBe("gone");
  });

  it("429, 5xx and network failures are transient", () => {
    expect(classifyPushError(429)).toBe("transient");
    expect(classifyPushError(500)).toBe("transient");
    expect(classifyPushError(503)).toBe("transient");
    expect(classifyPushError(null)).toBe("transient");
  });

  it("other 4xx are permanent (bad request/auth — never retried)", () => {
    expect(classifyPushError(400)).toBe("permanent");
    expect(classifyPushError(401)).toBe("permanent");
    expect(classifyPushError(413)).toBe("permanent");
  });
});

describe("endpointHash", () => {
  it("is a stable sha256 hex fingerprint", () => {
    const h = endpointHash("https://push.example/abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(endpointHash("https://push.example/abc")).toBe(h);
    expect(endpointHash("https://push.example/xyz")).not.toBe(h);
  });
});
