import { describe, it, expect, vi } from "vitest";

// The follow-ups page is a server component; stub its heavy imports so we can unit-test
// the exported pure quote-selection helper without pulling next/headers or client components.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/followups/followups-queue", () => ({ FollowUpsQueue: () => null }));

import { pickBestQuoteByLead } from "@/app/(dashboard)/follow-ups/page";

type Row = {
  lead_id: string | null;
  quote_ref: string;
  status: string;
  agreed_price: number | null;
  grand_total: number | null;
  created_at: string;
};

const q = (o: Partial<Row> & Pick<Row, "quote_ref" | "status" | "created_at">): Row => ({
  lead_id: "L1",
  agreed_price: null,
  grand_total: null,
  ...o,
});

describe("pickBestQuoteByLead", () => {
  it("picks the newest LIVE (sent) quote, not the oldest DB row, when none is accepted", () => {
    // The exact L5 failure: two 'sent' quotes £500 then £800, neither accepted.
    // DB physical order is oldest-first; the old code latched onto £500. Correct = £800.
    const rows: Row[] = [
      q({ quote_ref: "Q-1", status: "sent", grand_total: 500, created_at: "2026-07-01T10:00:00Z" }),
      q({ quote_ref: "Q-2", status: "sent", grand_total: 800, created_at: "2026-07-05T10:00:00Z" }),
    ];
    // Feed in DB-physical (oldest-first) order to prove we don't depend on input order.
    expect(pickBestQuoteByLead(rows).get("L1")).toEqual({ ref: "Q-2", value: 800 });
    // ...and reversed input yields the same deterministic result.
    expect(pickBestQuoteByLead([...rows].reverse()).get("L1")).toEqual({ ref: "Q-2", value: 800 });
  });

  it("prefers the accepted quote over any sent quote regardless of recency", () => {
    const rows: Row[] = [
      q({ quote_ref: "Q-A", status: "accepted", agreed_price: 700, created_at: "2026-07-01T10:00:00Z" }),
      q({ quote_ref: "Q-B", status: "sent", grand_total: 900, created_at: "2026-07-09T10:00:00Z" }),
    ];
    expect(pickBestQuoteByLead(rows).get("L1")).toEqual({ ref: "Q-A", value: 700 });
  });

  it("ignores superseded / rejected / draft quotes for the chase amount", () => {
    const rows: Row[] = [
      q({ quote_ref: "Q-OLD", status: "superseded", grand_total: 400, created_at: "2026-07-08T10:00:00Z" }),
      q({ quote_ref: "Q-REJ", status: "rejected", grand_total: 999, created_at: "2026-07-07T10:00:00Z" }),
      q({ quote_ref: "Q-DRAFT", status: "draft", grand_total: 111, created_at: "2026-07-06T10:00:00Z" }),
      q({ quote_ref: "Q-LIVE", status: "sent", grand_total: 600, created_at: "2026-07-02T10:00:00Z" }),
    ];
    // Even though a superseded row is newer, only the live 'sent' quote is used.
    expect(pickBestQuoteByLead(rows).get("L1")).toEqual({ ref: "Q-LIVE", value: 600 });
  });

  it("returns no entry when a lead has only non-live quotes", () => {
    const rows: Row[] = [
      q({ quote_ref: "Q-S", status: "superseded", grand_total: 400, created_at: "2026-07-08T10:00:00Z" }),
      q({ quote_ref: "Q-R", status: "rejected", grand_total: 500, created_at: "2026-07-07T10:00:00Z" }),
    ];
    expect(pickBestQuoteByLead(rows).has("L1")).toBe(false);
  });

  it("prefers agreed_price over grand_total for the value", () => {
    const rows: Row[] = [
      q({ quote_ref: "Q-A", status: "accepted", agreed_price: 750, grand_total: 800, created_at: "2026-07-01T10:00:00Z" }),
    ];
    expect(pickBestQuoteByLead(rows).get("L1")).toEqual({ ref: "Q-A", value: 750 });
  });

  it("keeps leads independent", () => {
    const rows: Row[] = [
      q({ lead_id: "L1", quote_ref: "Q-1", status: "sent", grand_total: 500, created_at: "2026-07-01T10:00:00Z" }),
      q({ lead_id: "L2", quote_ref: "Q-2", status: "accepted", agreed_price: 900, created_at: "2026-07-02T10:00:00Z" }),
      q({ lead_id: null, quote_ref: "Q-3", status: "sent", grand_total: 1, created_at: "2026-07-03T10:00:00Z" }),
    ];
    const m = pickBestQuoteByLead(rows);
    expect(m.get("L1")).toEqual({ ref: "Q-1", value: 500 });
    expect(m.get("L2")).toEqual({ ref: "Q-2", value: 900 });
    expect(m.size).toBe(2);
  });
});
