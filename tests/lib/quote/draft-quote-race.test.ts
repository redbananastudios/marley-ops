import { describe, expect, it, vi } from "vitest";

/**
 * QA-20260820-05: one "Create Quote" click created TWO draft quotes (MMR014 +
 * MMR015, 170ms apart). createDraftQuote's resume-a-draft guard is a SELECT
 * then INSERT, and /quotes/new runs it during the page RENDER — which Next can
 * fire twice for one navigation, so both passes read "no draft yet" before
 * either commits. Migration 0101's partial unique index
 * (quotes_one_draft_per_lead_uq) makes the second insert fail; this proves the
 * action catches that violation and hands back the WINNING row — both callers
 * end up on the same draft, no orphan, no second burned quote_ref.
 */

const LEAD = "22222222-2222-4222-8222-222222222222";

// Stateful fake DB. The first two draft-lookups return null regardless of the
// store — that IS the race: both renders read before either insert commits.
// Later lookups (the loser recovering the winner) see the store truthfully.
const db = {
  drafts: [] as { id: string; quote_ref: string; lead_id: string | null }[],
  draftLookups: 0,
  refSeq: 899,
};

function quotesChain() {
  const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
  q.maybeSingle = async () => {
    db.draftLookups += 1;
    if (db.draftLookups <= 2) return { data: null };
    const winner = db.drafts[0] ?? null;
    return { data: winner ? { id: winner.id, quote_ref: winner.quote_ref } : null };
  };
  q.insert = (row: { quote_ref: string; lead_id: string | null; status: string }) => ({
    select: () => ({
      single: async () => {
        // The partial unique index from migration 0101.
        if (row.lead_id !== null && db.drafts.some((d) => d.lead_id === row.lead_id)) {
          return {
            data: null,
            error: { message: 'duplicate key value violates unique constraint "quotes_one_draft_per_lead_uq"' },
          };
        }
        const rec = { id: `quote-${db.drafts.length + 1}`, quote_ref: row.quote_ref, lead_id: row.lead_id };
        db.drafts.push(rec);
        return { data: { id: rec.id, quote_ref: rec.quote_ref }, error: null };
      },
    }),
  });
  return q;
}

function leadsChain() {
  const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.single = async () => ({
    data: {
      id: LEAD,
      name: "Race Test",
      phone: null,
      email: null,
      client_id: null,
      from_address: null,
      from_postcode: null,
      to_address: null,
      to_postcode: null,
      preferred_date: null,
      property_size: null,
    },
  });
  return q;
}

function cubicChain() {
  const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: null });
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
    rpc: async () => ({ data: `MMR${(db.refSeq += 1)}`, error: null }),
    from: (table: string) => {
      if (table === "quotes") return quotesChain();
      if (table === "leads") return leadsChain();
      if (table === "cubic_surveys") return cubicChain();
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("@/lib/settings", () => ({
  getBusinessSettings: async () => ({ vatDefault: false, cubicFillPct: 80, cubicTransitFt3: 400, cubicLutonFt3: 600, cubic75tFt3: 1000 }),
}));
vi.mock("@/lib/quote/pricing-config", () => ({ getPricingConfig: async () => ({}) }));
vi.mock("@/lib/quote/pricing", () => ({
  computeQuote: () => ({ subtotal: 0, vatEnabled: false, vatAmount: 0, grandTotal: 0 }),
}));
vi.mock("@/lib/ai/planning", () => ({ getSurveyPlanningState: () => ({ guidanceReady: false, planningFt3: 0 }) }));
vi.mock("@/lib/quote/accept-flow", () => ({ acceptQuoteByStaff: vi.fn() }));
vi.mock("@/app/(dashboard)/leads/actions", () => ({ markLeadLostAction: vi.fn(), createLeadAction: vi.fn() }));

import { createDraftQuote } from "@/app/(dashboard)/quotes/actions";

describe("createDraftQuote under a concurrent double-fire (QA-20260820-05)", () => {
  it("both callers land on the SAME single draft — no orphan row, no burned ref", async () => {
    const [a, b] = await Promise.all([
      createDraftQuote({ leadId: LEAD }),
      createDraftQuote({ leadId: LEAD }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Exactly one draft exists, and both calls returned it.
    expect(db.drafts).toHaveLength(1);
    expect(a.id).toBe(db.drafts[0].id);
    expect(b.id).toBe(db.drafts[0].id);
    expect(a.quoteRef).toBe(b.quoteRef);
  });
});
