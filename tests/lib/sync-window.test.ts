import { describe, expect, it } from "vitest";
import { applySyncFloor } from "@/lib/sync/sync-window";

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
