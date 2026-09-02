import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * createDraftQuote asked for a lead by id and then carried on regardless of the
 * answer: the error was discarded, `lead` stayed null, and `lead?.brand ??
 * DEFAULT_BRAND` resolved the default brand — so a second brand's enquiry burned
 * a DEFAULT-prefixed reference and inserted a quote stamped with the wrong
 * brand and no lead at all, returned as ok. The office then typed the customer
 * into that builder with nothing on screen to say which brand it belonged to.
 *
 * Both answers must refuse, for different reasons: a failed read means we do
 * not KNOW the brand, and a missing lead means the quote has nothing to belong
 * to. The deliberate lead-less draft (no leadId at all) is untouched — that one
 * is a real product path and DEFAULT_BRAND is its correct answer.
 */

const LEAD = "33333333-3333-4333-8333-333333333333";

const db = {
  /** What the leads read answers with: a row, a PostgREST error, or the
   *  zero-rows shape `.single()` produces (PGRST116, data null). */
  leadResult: {} as { data: unknown; error: { code?: string; message: string } | null },
  inserts: [] as Record<string, unknown>[],
  refsMinted: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;

function quotesChain(): Chain {
  const q: Chain = {};
  for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: null }); // no draft to resume
  q.insert = (row: Record<string, unknown>) => ({
    select: () => ({
      single: async () => {
        db.inserts.push(row);
        return { data: { id: "quote-1", quote_ref: row.quote_ref }, error: null };
      },
    }),
  });
  return q;
}

function leadsChain(): Chain {
  const q: Chain = {};
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.single = async () => db.leadResult;
  return q;
}

function passthroughChain(): Chain {
  const q: Chain = {};
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: null });
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
    rpc: async () => {
      db.refsMinted += 1;
      return { data: `MMR${900 + db.refsMinted}`, error: null };
    },
    from: (table: string) => {
      if (table === "quotes") return quotesChain();
      if (table === "leads") return leadsChain();
      if (table === "cubic_surveys" || table === "clients") return passthroughChain();
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("@/lib/settings", () => ({
  getBusinessSettings: async () => ({
    vatDefault: false,
    cubicFillPct: 80,
    cubicTransitFt3: 400,
    cubicLutonFt3: 600,
    cubic75tFt3: 1000,
  }),
}));
vi.mock("@/lib/quote/pricing-config", () => ({ getPricingConfig: async () => ({}) }));
vi.mock("@/lib/quote/pricing", () => ({
  computeQuote: () => ({ subtotal: 0, vatEnabled: false, vatAmount: 0, grandTotal: 0 }),
}));
vi.mock("@/lib/ai/planning", () => ({ getSurveyPlanningState: () => ({ guidanceReady: false, planningFt3: 0 }) }));
vi.mock("@/lib/quote/accept-flow", () => ({ acceptQuoteByStaff: vi.fn(), snapshotPaymentPolicy: vi.fn() }));
vi.mock("@/app/(dashboard)/leads/actions", () => ({ markLeadLostAction: vi.fn(), createLeadAction: vi.fn() }));

import { createDraftQuote } from "@/app/(dashboard)/quotes/actions";

describe("createDraftQuote refuses when the lead it was given cannot be read", () => {
  beforeEach(() => {
    db.inserts = [];
    db.refsMinted = 0;
  });

  it("a FAILED leads read writes nothing — no reference minted, no quote row", async () => {
    db.leadResult = { data: null, error: { message: "connection reset" } };
    const res = await createDraftQuote({ leadId: LEAD });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/could not read/i);
    expect(db.refsMinted).toBe(0);
    expect(db.inserts).toHaveLength(0);
  });

  it("a MISSING lead refuses too — the quote would have nothing to belong to", async () => {
    db.leadResult = { data: null, error: { code: "PGRST116", message: "0 rows" } };
    const res = await createDraftQuote({ leadId: LEAD });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no longer exists/i);
    expect(db.inserts).toHaveLength(0);
  });

  it("the deliberate lead-less draft still works and still stamps the default brand", async () => {
    const res = await createDraftQuote({});
    expect(res.ok).toBe(true);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({ brand: "marley", lead_id: null });
  });

  it("a readable lead is used as before", async () => {
    db.leadResult = {
      data: { id: LEAD, name: "A Customer", brand: "pitmans", client_id: null, preferred_date: null },
      error: null,
    };
    const res = await createDraftQuote({ leadId: LEAD });
    expect(res.ok).toBe(true);
    expect(db.inserts[0]).toMatchObject({ brand: "pitmans", lead_id: LEAD });
  });
});
