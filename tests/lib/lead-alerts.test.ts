import { describe, expect, it } from "vitest";
import {
  ALERT_POLL_MS,
  CHIME_MAX_REPEATS,
  CHIME_REPEAT_MS,
  IMPORT_GAP_MS,
  isImportedUnackedRow,
  nextChimeState,
  parseChimedLeadIds,
  serializeChimedLeadIds,
} from "@/lib/lead-alerts";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";

describe("nextChimeState", () => {
  it("restarts on the first-ever unacked lead", () => {
    const d = nextChimeState(new Set(), [A]);
    expect(d.restart).toBe(true);
    expect([...d.chimed]).toEqual([A]);
  });

  it("does NOT restart when the same leads come back still unacked", () => {
    const d = nextChimeState(new Set([A, B]), [A, B]);
    expect(d.restart).toBe(false);
    expect(d.chimed).toEqual(new Set([A, B]));
  });

  it("restarts when a NEW lead id appears alongside old ones", () => {
    const d = nextChimeState(new Set([A]), [A, B]);
    expect(d.restart).toBe(true);
    expect(d.chimed).toEqual(new Set([A, B]));
  });

  it("goes quiet and forgets the batch when everything is acked", () => {
    const d = nextChimeState(new Set([A, B]), []);
    expect(d.restart).toBe(false);
    expect(d.chimed.size).toBe(0);
  });

  it("restarts for a genuinely new batch after the previous cleared", () => {
    // Previous batch acked -> empty set, then a fresh lead lands.
    const cleared = nextChimeState(new Set([A]), []).chimed;
    const d = nextChimeState(cleared, [C]);
    expect(d.restart).toBe(true);
    expect([...d.chimed]).toEqual([C]);
  });

  it("does not mutate the set passed in", () => {
    const prev = new Set([A]);
    nextChimeState(prev, [A, B]);
    expect(prev).toEqual(new Set([A]));
  });

  it("exposes sane chime-cycle constants", () => {
    expect(ALERT_POLL_MS).toBe(20_000);
    expect(CHIME_REPEAT_MS).toBe(3_000);
    expect(CHIME_MAX_REPEATS).toBe(10);
  });
});

describe("device chime ledger", () => {
  it("round-trips valid UUIDs and rejects malformed storage", () => {
    const encoded = serializeChimedLeadIds(new Set([A, B]));
    expect(parseChimedLeadIds(encoded)).toEqual(new Set([A, B]));
    expect(parseChimedLeadIds("not-json")).toEqual(new Set());
    expect(parseChimedLeadIds(JSON.stringify([A, "not-a-uuid"]))).toEqual(new Set([A]));
  });

  it("caps the ledger to the latest 100 ids", () => {
    const ids = Array.from({ length: 105 }, (_, i) =>
      `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
    );
    const parsed = parseChimedLeadIds(JSON.stringify(ids));
    expect(parsed.size).toBe(100);
    expect(parsed.has(ids[0])).toBe(false);
    expect(parsed.has(ids[104])).toBe(true);
  });
});

describe("isImportedUnackedRow (the sync ack-repair guard)", () => {
  const submitted = "2026-07-14T12:00:00Z";

  it("flags a row created well after submission — a historical import", () => {
    expect(isImportedUnackedRow("2026-07-16T12:00:01Z", submitted)).toBe(true);
  });

  it("a live-synced lead (created ≈ submitted) is NEVER an import — no matter its age", () => {
    // The weekend case: submitted Friday, still unacked Monday. The row was
    // created moments after submission, so the machine must not ack it.
    expect(isImportedUnackedRow("2026-07-14T12:00:05Z", submitted)).toBe(false);
    // Exactly at the 24h boundary still counts as live (guard is strict >).
    expect(
      isImportedUnackedRow(new Date(Date.parse(submitted) + IMPORT_GAP_MS).toISOString(), submitted),
    ).toBe(false);
  });

  it("missing or garbled timestamps never trigger the repair", () => {
    expect(isImportedUnackedRow(null, submitted)).toBe(false);
    expect(isImportedUnackedRow("2026-07-16T12:00:01Z", null)).toBe(false);
    expect(isImportedUnackedRow("not-a-date", submitted)).toBe(false);
    expect(isImportedUnackedRow("2026-07-16T12:00:01Z", "garbled")).toBe(false);
  });
});
