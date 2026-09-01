import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Marley-cancelling a booking must take it OFF the calendar — including a
 * removal whose date has already passed. Mirrors
 * tests/lib/leads/mark-lost-frees-diary.test.ts, which covers the same bug in
 * markLeadLostAction; this covers the second, independent code path that
 * used to have its own (looser but still present) date floor — a UK-day-start
 * gate rather than markLeadLostAction's `.gte(now)` — before both were
 * removed entirely in the same fix (2026-09-01).
 */

const LEAD = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const CLIENT = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  db.leads = [
    { id: LEAD, name: "Past Customer", email: null, client_id: CLIENT, status: "confirmed", balance_paid_at: null, date_confirmed_at: null, brand: "marley" },
  ];
  db.appointments = [
    // Cancelled by the office five days after the move date — the case the
    // UK-day-start floor used to miss.
    { id: "appt-past", lead_id: LEAD, appt_type: "removal", status: "scheduled", starts_at: "2026-08-21T07:00:00Z" },
    { id: "appt-future", lead_id: LEAD, appt_type: "survey", status: "scheduled", starts_at: "2099-01-01T09:00:00Z" },
    { id: "appt-done", lead_id: LEAD, appt_type: "removal", status: "completed", starts_at: "2026-06-01T07:00:00Z" },
  ];
  db.quotes = [];
  db.activities = [];
  db.events_log = [];
  db.follow_ups = [];
  db.refund_queue = [];
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
      // A `gte` on starts_at is precisely the bug — if one is ever
      // reintroduced it filters the past row out here and the test fails.
      return String(r[col] ?? "") >= String(val);
    });
  const run = () => {
    const rows = db[table] ?? [];
    const hit = rows.filter(match);
    if (state.op === "update") {
      hit.forEach((r) => Object.assign(r, state.patch));
      return { data: hit.map((r) => ({ ...r })), error: null };
    }
    if (state.op === "insert") {
      (db[table] ??= []).push({ ...state.patch });
      return { data: null, error: null };
    }
    return { data: hit.map((r) => ({ ...r })), error: null };
  };
  const q: Record<string, unknown> = {
    select: () => q,
    update: (patch: Row) => { state.op = "update"; state.patch = patch; return q; },
    insert: (row: Row) => { state.op = "insert"; state.patch = row; return q; },
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
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: builder }) }));
vi.mock("@/lib/ai/auth", () => ({
  requireOfficeProfile: async () => ({ id: "admin-1", role: "admin", active: true, full_name: "QA Admin" }),
}));
vi.mock("@/lib/comms/dispatch", () => ({
  dispatchComm: vi.fn(async () => ({ ok: true })),
  sendOpsAlert: vi.fn(),
}));
vi.mock("@/lib/refunds", () => ({
  buildHeldSnapshot: vi.fn(async () => ({ held: [], split: { total: 0 } })),
  createRefundQueueEntry: vi.fn(),
}));
vi.mock("@/lib/ledger", () => ({ asProvider: (p: string) => p, voidInvoice: vi.fn() }));
// cancelBookingAction's "customer" branch delegates to markLeadLostAction —
// not exercised by this test (it has its own coverage), but the real module
// pulls in @/lib/supabase/server, which needs mocking so import doesn't fail
// under vitest's no-network environment.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: builder, auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) } }),
}));
vi.mock("@/lib/comms/review-request", () => ({ sendReviewRequest: vi.fn() }));
vi.mock("@/lib/comms/cancellation-emails", () => ({ queueAmountsFor: vi.fn(() => ({})) }));

import { cancelBookingAction } from "@/app/actions/booking-change";

const apptById = (id: string) => db.appointments.find((r) => r.id === id);

describe("cancelBookingAction (Marley cancels) frees the diary", () => {
  beforeEach(reset);

  it("cancels a PAST removal cancelled days after its move date", async () => {
    const res = await cancelBookingAction({ leadId: LEAD, by: "marley" });
    expect(res.ok).toBe(true);
    expect(apptById("appt-past")?.status).toBe("cancelled");
  });

  it("still cancels future slots", async () => {
    await cancelBookingAction({ leadId: LEAD, by: "marley" });
    expect(apptById("appt-future")?.status).toBe("cancelled");
  });

  it("never rewrites a move that actually ran — only `scheduled` rows flip", async () => {
    await cancelBookingAction({ leadId: LEAD, by: "marley" });
    expect(apptById("appt-done")?.status).toBe("completed");
  });
});
