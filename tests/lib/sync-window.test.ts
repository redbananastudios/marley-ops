import { describe, expect, it } from "vitest";
import { applySyncFloor, resolveLeadFloor } from "@/lib/sync/sync-window";

describe("applySyncFloor (LEAD_SYNC_SINCE — the no-backfill go-live floor)", () => {
  it("no floor set → since passes through untouched (including undefined = full sync)", () => {
    expect(applySyncFloor(undefined, undefined)).toBeUndefined();
    expect(applySyncFloor(undefined, null)).toBeUndefined();
    expect(applySyncFloor("2026-07-01T00:00:00Z", undefined)).toBe("2026-07-01T00:00:00Z");
  });

  it("floor set + empty DB (no since) → the floor becomes the cutoff — a full sync can never pull history", () => {
    expect(applySyncFloor(undefined, "2026-07-22T09:00:00Z")).toBe("2026-07-22T09:00:00Z");
  });

  it("whichever is LATER wins — an incremental since behind the floor is lifted, ahead of it is kept", () => {
    expect(applySyncFloor("2026-06-01T00:00:00Z", "2026-07-22T09:00:00Z")).toBe("2026-07-22T09:00:00Z");
    expect(applySyncFloor("2026-08-01T00:00:00Z", "2026-07-22T09:00:00Z")).toBe("2026-08-01T00:00:00Z");
  });

  it("a garbled floor is ignored rather than silently corrupting the comparison", () => {
    expect(applySyncFloor("2026-07-01T00:00:00Z", "not-a-date")).toBe("2026-07-01T00:00:00Z");
    expect(applySyncFloor(undefined, "")).toBeUndefined();
  });
});

describe("resolveLeadFloor (fail-closed gate — a dropped LEAD_SYNC_SINCE must NOT re-import history)", () => {
  it("returns null when the env is unset, empty or garbled — the caller then REFUSES an unfloored full sync", () => {
    // null is the signal syncSanityLeads uses (with no incremental `since`) to
    // bail rather than re-import all pre-go-live submissions.
    expect(resolveLeadFloor(undefined)).toBeNull();
    expect(resolveLeadFloor(null)).toBeNull();
    expect(resolveLeadFloor("")).toBeNull();
    expect(resolveLeadFloor("   ")).toBeNull();
    expect(resolveLeadFloor("not-a-date")).toBeNull();
  });

  it("returns a valid ISO timestamp unchanged so a correctly-set floor still applies", () => {
    expect(resolveLeadFloor("2026-07-30T00:00:00Z")).toBe("2026-07-30T00:00:00Z");
  });
});
