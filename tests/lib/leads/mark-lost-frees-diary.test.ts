import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Marking a lead lost must take its booking OFF the calendar — including a
 * removal whose date has already passed.
 *
 * The unwind used to filter `.gte("starts_at", now)`, so it only freed FUTURE
 * slots. But a booking is routinely marked lost DAYS after its move date: the
 * customer went quiet, nobody closed it out, the office tidies up later. Those
 * rows stayed `scheduled` forever — still drawing a chip, still counting toward
 * the day's capacity badge, and (because `pickCurrentQuotes` excludes a
 * cancelled quote) reported by the month rail as "not priced", which sends the
 * office hunting for a price that already exists.
 *
 * Three live jobs were in exactly that state on 2026-08-28: Kevin Mc Inerney
 * (moved 15 Aug, cancelled 19 Aug), John Gale and Rob Gale (moved 20/21 Aug,
 * both cancelled 26 Aug) — every one of them priced, none of them real work.
 */

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CLIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  db.leads = [{ id: LEAD, name: "Rob Gale", client_id: CLIENT, status: "confirmed", balance_paid_at: null, date_confirmed_at: null }];
  db.appointments = [
    // The move ran a week ago and was never closed out — the case that used to be missed.
    { id: "appt-past", lead_id: LEAD, appt_type: "removal", status: "scheduled", starts_at: "2026-08-21T07:00:00Z" },
    // A future survey on the same lead — always was freed, must stay freed.
    { id: "appt-future", lead_id: LEAD, appt_type: "survey", status: "scheduled", starts_at: "2099-01-01T09:00:00Z" },
    // Already ran and was closed out properly: history, must NOT be rewritten.
    { id: "appt-done", lead_id: LEAD, appt_type: "removal", status: "completed", starts_at: "2026-06-01T07:00:00Z" },
  ];
  db.quotes = [];
  db.activities = [];
  db.follow_ups = [];
  db.communications = [];
}

function builder(table: string) {
  const state = {
    op: "select" as "select" | "update" | "insert" | "delete",
    filters: [] as [string, unknown, "eq" | "neq" | "gte" | "is"][],
    patch: {} as Row,
  };
  const match = (r: Row) =>
    state.filters.every(([col, val, kind]) => {
      if (kind === "eq") return r[col] === val;
      if (kind === "neq") return r[col] !== val;
      if (kind === "is") return r[col] == null;
      // A `gte` on starts_at is precisely the bug — if one is ever reintroduced
      // it filters the past row out here and the test below fails.
      return String(r[col] ?? "") >= String(val);
    });
  const run = () => {
    const rows = db[table] ?? [];
    const hit = rows.filter(match);
    if (state.op === "update") {
      hit.forEach((r) => Object.assign(r, state.patch));
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    if (state.op === "insert") return { data: null, error: null };
    return { data: hit.map((r) => ({ ...r })), error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    update: (patch: Row) => { state.op = "update"; state.patch = patch; return q; },
    insert: (row: Row) => { state.op = "insert"; (db[table] ??= []).push({ ...row }); return q; },
    delete: () => { state.op = "delete"; return q; },
    eq: (c: string, v: unknown) => { state.filters.push([c, v, "eq"]); return q; },
    neq: (c: string, v: unknown) => { state.filters.push([c, v, "neq"]); return q; },
    gte: (c: string, v: unknown) => { state.filters.push([c, v, "gte"]); return q; },
    is: (c: string, v: unknown) => { state.filters.push([c, v, "is"]); return q; },
    in: (c: string, v: unknown[]) => { state.filters.push([c, v, "eq"]); return q; },
    order: () => q,
    limit: () => q,
    range: () => q,
    single: () => run(),
    maybeSingle: () => ({ data: run().data?.[0] ?? null, error: null }),
  };
  q.then = (resolve: (v: unknown) => void) => resolve(run());
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: builder,
    auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: builder }) }));
vi.mock("@/lib/ai/auth", () => ({
  requireOfficeProfile: async () => ({ id: "admin-1", role: "admin", active: true, full_name: "QA Admin" }),
}));
vi.mock("@/lib/comms/dispatch", () => ({ sendOpsAlert: vi.fn() }));
vi.mock("@/lib/comms/review-request", () => ({ sendReviewRequest: vi.fn() }));
vi.mock("@/lib/zoho", () => ({ voidInvoice: vi.fn() }));
vi.mock("@/lib/refunds", () => ({
  buildHeldSnapshot: vi.fn(async () => ({ held: [], split: {} })),
  createRefundQueueEntry: vi.fn(),
}));
vi.mock("@/lib/comms/cancellation-emails", () => ({ queueAmountsFor: vi.fn(() => ({})) }));

import { markLeadLostAction } from "@/app/(dashboard)/leads/actions";

const apptById = (id: string) => db.appointments.find((r) => r.id === id);

describe("markLeadLostAction frees the diary", () => {
  beforeEach(reset);

  it("cancels a PAST removal that was never closed out", async () => {
    await markLeadLostAction(LEAD, "no_response");
    expect(apptById("appt-past")?.status).toBe("cancelled");
  });

  it("still cancels future slots", async () => {
    await markLeadLostAction(LEAD, "no_response");
    expect(apptById("appt-future")?.status).toBe("cancelled");
  });

  it("never rewrites a move that actually ran — only `scheduled` rows flip", async () => {
    await markLeadLostAction(LEAD, "no_response");
    expect(apptById("appt-done")?.status).toBe("completed");
  });
});
