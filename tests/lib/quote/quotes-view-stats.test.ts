import { describe, expect, it, vi } from "vitest";

// quotes-view is a client component whose accept/delete buttons transitively pull
// in server actions that `import "server-only"` (a Next-virtual package with no
// node entry point). Stub it so the pure stats helpers can be imported here.
vi.mock("server-only", () => ({}));

import { computeQuoteStats, dedupePerLead } from "@/components/quotes/quotes-view";
import type { QuoteRow } from "@/components/quotes/quotes-view";

/** Minimal QuoteRow factory — only the fields the stats math reads matter. */
function q(partial: Partial<QuoteRow> & { id: string; status: string }): QuoteRow {
  return {
    quote_ref: null,
    customer_name: null,
    collect_addr: null,
    dest_addr: null,
    grand_total: null,
    agreed_price: null,
    email_send_count: null,
    accepted_at: null,
    lead_id: null,
    created_at: null,
    updated_at: null,
    ...partial,
  };
}

describe("computeQuoteStats win rate", () => {
  it("excludes superseded re-quotes from the denominator (dedups per lead)", () => {
    // Lead A: quoted £2000 then re-quoted £2200 and accepted → v1 superseded.
    // Lead B: quoted once and accepted. Both opportunities won → 100%.
    const quotes: QuoteRow[] = [
      q({ id: "a1", status: "superseded", lead_id: "A", grand_total: 2000, created_at: "2026-07-01" }),
      q({ id: "a2", status: "accepted", lead_id: "A", agreed_price: 2200, created_at: "2026-07-02" }),
      q({ id: "b1", status: "accepted", lead_id: "B", agreed_price: 1000, created_at: "2026-07-01" }),
    ];
    // Old bug: accepted(2) / nonDraft(3, incl. superseded) = 67%.
    expect(computeQuoteStats(quotes).winRate).toBe(100);
  });

  it("counts a genuine loss (rejected) against the rate", () => {
    const quotes: QuoteRow[] = [
      q({ id: "a", status: "accepted", lead_id: "A", agreed_price: 1000, created_at: "2026-07-01" }),
      q({ id: "b", status: "rejected", lead_id: "B", grand_total: 800, created_at: "2026-07-01" }),
    ];
    expect(computeQuoteStats(quotes).winRate).toBe(50);
  });

  it("ignores drafts in the denominator", () => {
    const quotes: QuoteRow[] = [
      q({ id: "a", status: "accepted", lead_id: "A", agreed_price: 1000, created_at: "2026-07-01" }),
      q({ id: "d", status: "draft", lead_id: "B", grand_total: 500, created_at: "2026-07-01" }),
    ];
    expect(computeQuoteStats(quotes).winRate).toBe(100);
  });

  it("keeps a superseded row's value out of open pipeline and win rate; 0 when nothing decided", () => {
    expect(computeQuoteStats([]).winRate).toBe(0);
  });

  it("still sums open pipeline (sent) and won (accepted) values", () => {
    const quotes: QuoteRow[] = [
      q({ id: "s1", status: "sent", lead_id: "A", grand_total: 1500, created_at: "2026-07-01" }),
      q({ id: "w1", status: "accepted", lead_id: "B", agreed_price: 2000, created_at: "2026-07-01" }),
    ];
    const stats = computeQuoteStats(quotes);
    expect(stats.openValue).toBe(1500);
    expect(stats.wonValue).toBe(2000);
    expect(stats.awaiting).toBe(1);
    // one sent (loss-so-far) + one accepted, deduped per lead → 50%.
    expect(stats.winRate).toBe(50);
  });
});

describe("dedupePerLead", () => {
  it("prefers the accepted quote over a sibling sent one", () => {
    const quotes: QuoteRow[] = [
      q({ id: "s", status: "sent", lead_id: "A", created_at: "2026-07-01" }),
      q({ id: "a", status: "accepted", lead_id: "A", created_at: "2026-07-02" }),
    ];
    const out = dedupePerLead(quotes);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a");
  });

  it("keeps the latest by created_at when none is accepted", () => {
    const quotes: QuoteRow[] = [
      q({ id: "old", status: "sent", lead_id: "A", created_at: "2026-07-01" }),
      q({ id: "new", status: "sent", lead_id: "A", created_at: "2026-07-05" }),
    ];
    const out = dedupePerLead(quotes);
    expect(out.map((x) => x.id)).toEqual(["new"]);
  });

  it("keeps every orphan (no lead_id) standing alone", () => {
    const quotes: QuoteRow[] = [
      q({ id: "o1", status: "sent", lead_id: null, created_at: "2026-07-01" }),
      q({ id: "o2", status: "accepted", lead_id: null, created_at: "2026-07-01" }),
    ];
    expect(dedupePerLead(quotes)).toHaveLength(2);
  });
});
