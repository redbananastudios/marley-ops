import { describe, expect, it, vi } from "vitest";

import { landWebsiteLead, toDateOrNull, toTimestampOrNull } from "@/lib/leads/website-lead";

/**
 * `landWebsiteLead` is the single insert path for BOTH website delivery routes:
 * the direct ingest POST and the Sanity sync that has been delivering every
 * real enquiry since go-live. Extracting it merged two working code paths into
 * one, so these tests exist to pin the behaviours a regression here would cost
 * us — every one of them is a way to silently lose or duplicate a customer.
 *
 * The dedupe-by-sanity_id case is the sharpest. `external_lead_id` is NULL on
 * every lead that exists today, so if the lookup ever stopped falling back to
 * `sanity_id`, the very next sync run would re-insert the entire recent history
 * as duplicate customers.
 */

const CLIENT = "c0000000-0000-4000-8000-000000000001";
const EXISTING = "10000000-0000-4000-8000-000000000001";
const INSERTED = "20000000-0000-4000-8000-000000000002";

vi.mock("@/lib/leads/resolver", () => ({
  attachOrCreateClient: async () => ({ clientId: CLIENT }),
}));

type Row = { id: string; web_alert_ack_at: string | null; created_at: string };

/**
 * Minimal Supabase stand-in. `rows` maps "<column>=<value>" to the row a lookup
 * on that column should find; `readError` forces the failure case; `insert`
 * captures the payload (or replays a Postgres error code).
 */
function fakeSb(opts: {
  rows?: Record<string, Row>;
  readError?: { message: string };
  insertError?: { code?: string; message: string };
  onInsert?: (payload: Record<string, unknown>) => void;
  /** Rows that only appear AFTER an insert — the lost-race re-read. */
  rowsAfterInsert?: Record<string, Row>;
}) {
  let inserted = false;
  const current = () => (inserted && opts.rowsAfterInsert ? opts.rowsAfterInsert : (opts.rows ?? {}));
  return {
    from: () => {
      let key = "";
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, val: string) => ((key = `${col}=${val}`), q);
      q.maybeSingle = async () =>
        opts.readError ? { data: null, error: opts.readError } : { data: current()[key] ?? null, error: null };
      q.insert = (payload: Record<string, unknown>) => {
        inserted = true;
        opts.onInsert?.(payload);
        return {
          select: () => ({
            single: async () =>
              opts.insertError
                ? { data: null, error: opts.insertError }
                : { data: { id: INSERTED }, error: null },
          }),
        };
      };
      return q;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const NOW = new Date("2026-08-20T12:00:00.000Z");
const base = { name: "paul betty", phone: "07700900123", fromPostcode: "bh218nb" };
const row = (id: string): Row => ({ id, web_alert_ack_at: null, created_at: "2026-08-19T09:00:00.000Z" });

describe("landWebsiteLead — dedupe", () => {
  it("finds an existing lead by the site's own id", async () => {
    const sb = fakeSb({ rows: { "external_lead_id=abc": row(EXISTING) } });
    const res = await landWebsiteLead(sb, { ...base, externalLeadId: "abc" }, NOW);
    expect(res).toMatchObject({ leadId: EXISTING, created: false });
  });

  it("STILL falls back to sanity_id — every lead landed to date has no external_lead_id", async () => {
    // The regression this guards: dropping the fallback would make the next
    // sync run re-insert the whole recent history as duplicate customers.
    const sb = fakeSb({ rows: { "sanity_id=doc-1": row(EXISTING) } });
    const res = await landWebsiteLead(sb, { ...base, externalLeadId: "never-seen", sanityId: "doc-1" }, NOW);
    expect(res).toMatchObject({ leadId: EXISTING, created: false });
  });

  it("returns the existing row's alarm columns so the sync can repair a stuck alert", async () => {
    const sb = fakeSb({ rows: { "sanity_id=doc-1": row(EXISTING) } });
    const res = await landWebsiteLead(sb, { ...base, sanityId: "doc-1" }, NOW);
    expect(res.existing).toEqual({ web_alert_ack_at: null, created_at: "2026-08-19T09:00:00.000Z" });
  });

  it("inserts when neither id is known", async () => {
    const sb = fakeSb({ rows: {} });
    const res = await landWebsiteLead(sb, { ...base, externalLeadId: "new-1" }, NOW);
    expect(res).toMatchObject({ leadId: INSERTED, created: true });
  });
});

describe("landWebsiteLead — failure handling", () => {
  it("THROWS on a failed existence read rather than inserting", async () => {
    // A failed read is not evidence the lead is absent. Inserting on it would
    // duplicate a customer already sitting in the panel.
    const sb = fakeSb({ readError: { message: "connection reset" } });
    await expect(landWebsiteLead(sb, { ...base, externalLeadId: "abc" }, NOW)).rejects.toMatchObject({
      message: "connection reset",
    });
  });

  it("adopts the winner when a concurrent delivery wins the unique index", async () => {
    const sb = fakeSb({
      rows: {},
      insertError: { code: "23505", message: "duplicate key" },
      rowsAfterInsert: { "external_lead_id=race": row(EXISTING) },
    });
    const res = await landWebsiteLead(sb, { ...base, externalLeadId: "race" }, NOW);
    expect(res).toMatchObject({ leadId: EXISTING, created: false });
  });

  it("rethrows an insert error that is not a uniqueness race", async () => {
    const sb = fakeSb({ rows: {}, insertError: { code: "23502", message: "null value" } });
    await expect(landWebsiteLead(sb, { ...base, externalLeadId: "x" }, NOW)).rejects.toMatchObject({
      code: "23502",
    });
  });
});

describe("landWebsiteLead — what gets written", () => {
  it("normalises the customer's own typing and keeps both id spaces apart", async () => {
    let payload: Record<string, unknown> = {};
    const sb = fakeSb({ rows: {}, onInsert: (p) => (payload = p) });
    await landWebsiteLead(
      sb,
      { ...base, externalLeadId: "e-1", sanityId: "doc-9", toPostcode: "sp78aa", preferredDate: "ASAP" },
      NOW,
    );
    expect(payload.name).toBe("Paul Betty");
    expect(payload.from_postcode).toBe("BH21 8NB");
    expect(payload.to_postcode).toBe("SP7 8AA");
    // Free text must never reach a date column.
    expect(payload.preferred_date).toBeNull();
    expect(payload.external_lead_id).toBe("e-1");
    expect(payload.sanity_id).toBe("doc-9");
    expect(payload.entry_channel).toBe("web");
    expect(payload.status).toBe("website_enquiry");
  });

  it("leaves a FRESH enquiry unacknowledged so the office alarm fires", async () => {
    let payload: Record<string, unknown> = {};
    const sb = fakeSb({ rows: {}, onInsert: (p) => (payload = p) });
    await landWebsiteLead(
      sb,
      { ...base, externalLeadId: "fresh", submittedAt: "2026-08-20T11:59:00.000Z" },
      NOW,
    );
    expect(payload.web_alert_ack_at).toBeNull();
  });

  it("pre-acknowledges a stale submission so a backfill never rings the alarm", async () => {
    let payload: Record<string, unknown> = {};
    const sb = fakeSb({ rows: {}, onInsert: (p) => (payload = p) });
    await landWebsiteLead(
      sb,
      { ...base, externalLeadId: "old", submittedAt: "2026-01-01T00:00:00.000Z" },
      NOW,
    );
    expect(payload.web_alert_ack_at).toBe(NOW.toISOString());
  });

  it("never writes an empty services array as null, and carries attribution through", async () => {
    let payload: Record<string, unknown> = {};
    const sb = fakeSb({ rows: {}, onInsert: (p) => (payload = p) });
    await landWebsiteLead(
      sb,
      { ...base, externalLeadId: "a", attribution: { gclid: "g1", utmSource: "google", liFatId: "li1" } },
      NOW,
    );
    expect(payload.services).toEqual([]);
    expect(payload.gclid).toBe("g1");
    expect(payload.utm_source).toBe("google");
    expect(payload.li_fat_id).toBe("li1");
  });
});

describe("coercion helpers", () => {
  it.each([
    ["2026-08-21", "2026-08-21"],
    ["2026-08-21T10:00:00Z", "2026-08-21"],
    ["ASAP", null],
    ["2-3 weeks", null],
    ["", null],
    [null, null],
  ])("toDateOrNull(%s) -> %s", (input, expected) => {
    expect(toDateOrNull(input as string | null)).toBe(expected);
  });

  it.each([
    ["2026-08-21T10:00:00Z", "2026-08-21T10:00:00Z"],
    ["not a date", null],
    ["", null],
    [null, null],
  ])("toTimestampOrNull(%s) -> %s", (input, expected) => {
    expect(toTimestampOrNull(input as string | null)).toBe(expected);
  });
});
