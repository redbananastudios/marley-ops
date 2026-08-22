import { describe, expect, it } from "vitest";

import {
  DEFAULT_PUSH_LIVE_SINCE,
  opsIngestFault,
  resolvePushFloor,
  selectOpsIngestFaults,
  type LeadDeliveryDoc,
} from "@/lib/sync/lead-delivery-health";

/**
 * The website pushes each enquiry straight to /api/ingest/lead AND writes a
 * `leadDelivery` audit doc to Sanity recording how every channel went. The push
 * is fail-soft and the Sanity pull backstops it, so a broken push loses nothing
 * and reports nothing — enquiries just quietly go from sub-second to up to ~84
 * minutes. These rules decide when that silence becomes an alert.
 */

const doc = (over: Partial<LeadDeliveryDoc> & { _id: string; _createdAt: string }): LeadDeliveryDoc => ({
  leadId: "lead-1",
  channels: { opsIngest: { ok: true } },
  ...over,
});

const NOW = new Date("2026-08-22T18:00:00Z");
const FLOOR = DEFAULT_PUSH_LIVE_SINCE;

describe("opsIngestFault", () => {
  it("a landed push is not a fault", () => {
    expect(opsIngestFault(doc({ _id: "a", _createdAt: "2026-08-22T09:00:00Z" }))).toBeNull();
  });

  it("treats a SKIPPED push as a fault — dormant is the silent regression", () => {
    // This is the exact shape the live site emitted while the feature was
    // deployed but unconfigured. After the floor it means the config was LOST.
    const f = opsIngestFault(
      doc({
        _id: "b",
        _createdAt: "2026-08-22T09:00:00Z",
        channels: { opsIngest: { ok: false, skipped: true, error: "ops ingest not configured" } },
      }),
    );
    expect(f).not.toBeNull();
    expect(f!.reason).toContain("dormant");
    expect(f!.reason).toContain("ops ingest not configured");
  });

  it("treats an explicit failure as a fault and carries the error through", () => {
    const f = opsIngestFault(
      doc({ _id: "c", _createdAt: "2026-08-22T09:00:00Z", channels: { opsIngest: { ok: false, error: "401 unauthorized" } } }),
    );
    expect(f!.reason).toContain("failed");
    expect(f!.reason).toContain("401 unauthorized");
  });

  it("treats a MISSING opsIngest channel as a fault, not as silence to ignore", () => {
    // An older build serving is a real regression; absence of a result is not
    // evidence the push worked.
    expect(opsIngestFault(doc({ _id: "d", _createdAt: "2026-08-22T09:00:00Z", channels: {} }))).not.toBeNull();
    expect(opsIngestFault(doc({ _id: "e", _createdAt: "2026-08-22T09:00:00Z", channels: null }))).not.toBeNull();
  });

  it("never invents an error string when the site recorded none", () => {
    const f = opsIngestFault(doc({ _id: "f", _createdAt: "2026-08-22T09:00:00Z", channels: { opsIngest: { ok: false } } }));
    expect(f!.reason).toContain("no error recorded");
  });
});

describe("selectOpsIngestFaults", () => {
  it("ignores the dormant era before the push went live", () => {
    // REAL production data: this delivery is Christina's, 2026-08-21T07:47:48Z,
    // recorded `ops ingest not configured` because the switch had not been
    // thrown yet. It is not a fault and must never alert.
    const christina = doc({
      _id: "xzEAqIDZGeWRT1GgDA0M3F",
      _createdAt: "2026-08-21T07:47:48Z",
      channels: { opsIngest: { ok: false, skipped: true, error: "ops ingest not configured" } },
    });
    expect(selectOpsIngestFaults([christina], { now: NOW, windowHours: 72, pushFloor: FLOOR })).toEqual([]);
  });

  it("catches the same shape once the push is live", () => {
    const afterFloor = doc({
      _id: "later",
      _createdAt: "2026-08-22T09:00:00Z",
      channels: { opsIngest: { ok: false, skipped: true, error: "ops ingest not configured" } },
    });
    expect(selectOpsIngestFaults([afterFloor], { now: NOW, windowHours: 72, pushFloor: FLOOR })).toHaveLength(1);
  });

  it("drops deliveries older than the rolling window even when they failed", () => {
    const old = doc({
      _id: "stale",
      _createdAt: "2026-08-01T09:00:00Z",
      channels: { opsIngest: { ok: false, error: "boom" } },
    });
    expect(selectOpsIngestFaults([old], { now: NOW, windowHours: 24, pushFloor: FLOOR })).toEqual([]);
  });

  it("returns newest first, so an alert leads with the most recent", () => {
    const mk = (id: string, at: string) =>
      doc({ _id: id, _createdAt: at, channels: { opsIngest: { ok: false, error: "boom" } } });
    const out = selectOpsIngestFaults(
      [mk("older", "2026-08-22T08:00:00Z"), mk("newer", "2026-08-22T15:00:00Z")],
      { now: NOW, windowHours: 72, pushFloor: FLOOR },
    );
    expect(out.map((f) => f.docId)).toEqual(["newer", "older"]);
  });

  it("a healthy run is an empty list, not an error", () => {
    expect(selectOpsIngestFaults([doc({ _id: "ok", _createdAt: "2026-08-22T09:00:00Z" })], {
      now: NOW,
      windowHours: 72,
      pushFloor: FLOOR,
    })).toEqual([]);
  });

  it("survives an unparseable _createdAt without counting it", () => {
    const bad = doc({ _id: "bad", _createdAt: "not-a-date", channels: { opsIngest: { ok: false, error: "boom" } } });
    expect(selectOpsIngestFaults([bad], { now: NOW, windowHours: 72, pushFloor: FLOOR })).toEqual([]);
  });
});

describe("resolvePushFloor", () => {
  it("defaults to the day the push went live", () => {
    expect(resolvePushFloor(undefined)).toBe(DEFAULT_PUSH_LIVE_SINCE);
    expect(resolvePushFloor("")).toBe(DEFAULT_PUSH_LIVE_SINCE);
  });

  it("accepts a deliberate override", () => {
    expect(resolvePushFloor("2026-09-01T00:00:00Z")).toBe("2026-09-01T00:00:00.000Z");
  });

  it("falls back rather than widening the window on a garbled value", () => {
    // Failing open here would re-alert on every pre-go-live delivery — the same
    // fail-closed instinct as LEAD_SYNC_SINCE in lib/sync/sync-window.ts.
    expect(resolvePushFloor("garbage")).toBe(DEFAULT_PUSH_LIVE_SINCE);
  });
});
