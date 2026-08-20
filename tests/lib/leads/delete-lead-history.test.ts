import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA-20260820-07: deleting a no-sibling duplicate lead ALWAYS failed with
 * "Could not delete the lead." whenever the lead had any activities or
 * communications row — the common case, since creating a lead writes an
 * activity. Neither FK carries an ON DELETE clause (follow_ups cascades), so
 * Postgres refused the lead delete and the catch-all swallowed the violation.
 * The fake DB below enforces exactly those constraints; the no-sibling test
 * fails against the pre-fix action.
 */

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SIBLING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CLIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  db.leads = [{ id: LEAD, name: "Dupe", client_id: CLIENT }];
  db.activities = [{ id: "act-1", lead_id: LEAD, summary: "Lead created" }];
  db.communications = [{ id: "comm-1", lead_id: LEAD }];
  db.follow_ups = [{ id: "fu-1", lead_id: LEAD }];
}

function builder(table: string) {
  const state = {
    op: "select" as "select" | "update" | "delete",
    filters: [] as [string, unknown, "eq" | "neq"][],
    patch: {} as Row,
  };
  const match = (r: Row) =>
    state.filters.every(([col, val, kind]) => (kind === "eq" ? r[col] === val : r[col] !== val));
  const run = () => {
    const rows = db[table] ?? [];
    const hit = rows.filter(match);
    if (state.op === "update") {
      hit.forEach((r) => Object.assign(r, state.patch));
      return { data: null, error: null, count: null };
    }
    if (state.op === "delete") {
      if (table === "leads") {
        // The real constraints: activities/communications FKs have no ON
        // DELETE clause, follow_ups is ON DELETE CASCADE (0014).
        for (const lead of hit) {
          const blocked = ["activities", "communications"].some((t) =>
            (db[t] ?? []).some((r) => r.lead_id === lead.id),
          );
          if (blocked) {
            return {
              data: null,
              count: null,
              error: {
                code: "23503",
                message: 'update or delete on table "leads" violates foreign key constraint',
              },
            };
          }
          db.follow_ups = (db.follow_ups ?? []).filter((r) => r.lead_id !== lead.id);
        }
      }
      db[table] = rows.filter((r) => !match(r));
      return { data: null, error: null, count: null };
    }
    return { data: hit, error: null, count: hit.length };
  };
  const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  q.select = () => q;
  q.update = (patch: Row) => ((state.op = "update"), (state.patch = patch), q);
  q.delete = () => ((state.op = "delete"), q);
  q.insert = async (row: Row) => ((db[table] ??= []).push(row), { data: null, error: null });
  q.eq = (col: string, val: unknown) => (state.filters.push([col, val, "eq"]), q);
  q.neq = (col: string, val: unknown) => (state.filters.push([col, val, "neq"]), q);
  q.maybeSingle = async () => {
    const res = run();
    return { data: (res.data as Row[] | null)?.[0] ?? null, error: null };
  };
  q.then = (resolve: (v: unknown) => void) => resolve(run());
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: builder }) }));
vi.mock("@/lib/ai/auth", () => ({
  requireOfficeProfile: async () => ({ id: "admin-1", role: "admin", active: true, full_name: "QA Admin" }),
}));
vi.mock("@/lib/comms/dispatch", () => ({ sendOpsAlert: vi.fn() }));
vi.mock("@/lib/comms/review-request", () => ({ sendReviewRequest: vi.fn() }));
vi.mock("@/lib/zoho", () => ({ voidInvoice: vi.fn() }));
vi.mock("@/lib/refunds", () => ({ buildHeldSnapshot: vi.fn(), createRefundQueueEntry: vi.fn() }));
vi.mock("@/lib/comms/cancellation-emails", () => ({ queueAmountsFor: vi.fn() }));

import { deleteLeadAction } from "@/app/(dashboard)/leads/actions";

describe("deleteLeadAction and the lead's own history rows (QA-20260820-07)", () => {
  beforeEach(reset);

  it("no sibling: history rows go with the lead instead of blocking the delete", async () => {
    const res = await deleteLeadAction(LEAD);

    expect(res).toEqual({ ok: true, mergedInto: null });
    expect(db.leads).toHaveLength(0);
    expect(db.activities.filter((r) => r.lead_id === LEAD)).toHaveLength(0);
    expect(db.communications.filter((r) => r.lead_id === LEAD)).toHaveLength(0);
    expect(db.follow_ups).toHaveLength(0);
  });

  it("one sibling: history is re-pointed at the survivor, not deleted", async () => {
    db.leads.push({ id: SIBLING, name: "Original", client_id: CLIENT });

    const res = await deleteLeadAction(LEAD);

    expect(res).toEqual({ ok: true, mergedInto: SIBLING });
    expect(db.leads.map((r) => r.id)).toEqual([SIBLING]);
    // The pre-existing activity survived on the sibling, plus the merge note.
    expect(db.activities.filter((r) => r.lead_id === SIBLING && r.id === "act-1")).toHaveLength(1);
    expect(db.communications.filter((r) => r.lead_id === SIBLING)).toHaveLength(1);
    expect(db.follow_ups.filter((r) => r.lead_id === SIBLING)).toHaveLength(1);
  });
});
