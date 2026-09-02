import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Defect: a brands-read failure silently files a Pitmans lead as Marley.
 *
 * `listActiveBrands` used to destructure only `{ data }`, so a QUERY ERROR
 * returned `[]` — indistinguishable from single-brand mode. createLeadAction's
 * gate-5 block then took the single-brand arm and inserted `brand='marley'`,
 * silently discarding the office's pick. The fake DB below can be told to fail
 * the brands read; the refusal tests fail against the pre-fix action.
 *
 * The control tests pin the two behaviours that must NOT change: single-brand
 * mode still writes DEFAULT_BRAND without a picker, and multi-brand mode still
 * honours a valid pick / refuses a missing one.
 */

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CLIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let brandsReadError: string | null = null;
let idSeq = 0;

const MARLEY = {
  slug: "marley",
  name: "Marley Moves",
  short_name: "Marley",
  group_line: "Part of the Marley Group",
  legal_line: "MarleyMoves Ltd",
  active: true,
  sort_order: 0,
};
const PITMANS = {
  slug: "pitmans",
  name: "Pitmans Removals & Storage",
  short_name: "Pitmans",
  group_line: "Part of the Marley Group",
  legal_line: "Pitmans Removals & Storage is a trading name of MarleyMoves Ltd.",
  active: true,
  sort_order: 1,
};

function reset() {
  for (const k of Object.keys(db)) delete db[k];
  db.brands = [{ ...MARLEY }, { ...PITMANS }];
  db.leads = [];
  db.activities = [];
  db.quotes = [];
  db.appointments = [];
  db.booking_details = [];
  brandsReadError = null;
  idSeq = 0;
}

function builder(table: string) {
  const state = {
    op: "select" as "select" | "insert" | "update" | "upsert",
    filters: [] as Array<(r: Row) => boolean>,
    patch: {} as Row,
    inserted: [] as Row[],
  };
  const run = () => {
    if (table === "brands" && state.op === "select" && brandsReadError) {
      return { data: null, error: { message: brandsReadError }, count: null };
    }
    const rows = db[table] ?? [];
    if (state.op === "insert" || state.op === "upsert") {
      for (const r of state.inserted) {
        if (r.id == null) r.id = `${table}-${++idSeq}`;
        (db[table] ??= []).push(r);
      }
      return { data: state.inserted, error: null, count: null };
    }
    const hit = rows.filter((r) => state.filters.every((f) => f(r)));
    if (state.op === "update") {
      hit.forEach((r) => Object.assign(r, state.patch));
      return { data: hit, error: null, count: null };
    }
    return { data: hit, error: null, count: hit.length };
  };
  const q: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  q.select = () => q;
  q.insert = (row: Row | Row[]) => (
    (state.op = "insert"),
    (state.inserted = (Array.isArray(row) ? row : [row]).map((r) => ({ ...r }))),
    q
  );
  q.update = (patch: Row) => ((state.op = "update"), (state.patch = patch), q);
  q.upsert = (row: Row) => ((state.op = "upsert"), (state.inserted = [{ ...row }]), q);
  q.eq = (col: string, val: unknown) => (state.filters.push((r) => r[col] === val), q);
  q.neq = (col: string, val: unknown) => (state.filters.push((r) => r[col] !== val), q);
  q.is = (col: string, val: unknown) => (state.filters.push((r) => r[col] === val), q);
  q.not = (col: string, op: string, val: unknown) => (
    state.filters.push((r) => (op === "is" && val === null ? r[col] !== null : true)),
    q
  );
  q.order = () => q;
  q.limit = () => q;
  q.single = async () => {
    const res = run();
    const row = (res.data as Row[] | null)?.[0] ?? null;
    return { data: row, error: res.error ?? (row ? null : { message: "0 rows" }) };
  };
  q.maybeSingle = async () => {
    const res = run();
    return { data: (res.data as Row[] | null)?.[0] ?? null, error: res.error };
  };
  q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(run()).then(resolve, reject);
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
    from: builder,
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: builder }) }));
vi.mock("@/lib/ai/auth", () => ({
  requireOfficeProfile: async () => ({ id: "office-1", role: "admin", active: true, full_name: "QA Office" }),
}));
vi.mock("@/lib/comms/dispatch", () => ({ sendOpsAlert: vi.fn() }));
vi.mock("@/lib/comms/review-request", () => ({ sendReviewRequest: vi.fn() }));
vi.mock("@/lib/ledger", () => ({ asProvider: vi.fn(), voidInvoice: vi.fn() }));
vi.mock("@/lib/refunds", () => ({ buildHeldSnapshot: vi.fn(), createRefundQueueEntry: vi.fn() }));
vi.mock("@/lib/comms/cancellation-emails", () => ({ queueAmountsFor: vi.fn() }));
vi.mock("@/lib/leads/resolver", () => ({
  attachOrCreateClient: async () => ({ clientId: CLIENT, matched: false, previousLeadCount: 0 }),
  findExistingClient: async () => null,
}));

import { createLeadAction, updateLeadBrandAction } from "@/app/(dashboard)/leads/actions";

const input = {
  brand: "pitmans",
  name: "Test Person",
  client_id: "",
  phone: "07700 900123",
  email: "",
  entry_channel: "phone_google" as const,
  referrer_answer: "",
  from_postcode: "",
  to_postcode: "",
  from_address: "",
  to_address: "",
  property_size: "",
  to_property_size: "",
  preferred_date: "",
  approx_month: "",
  approx_window: "" as const,
  referral_commission: "",
  notes: "",
};

describe("createLeadAction and a failed brands read", () => {
  beforeEach(reset);

  it("REFUSES when the brands read fails — never files the enquiry as Marley", async () => {
    brandsReadError = "connection reset";
    const res = await createLeadAction(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/brand/i);
    // Nothing was written — no lead, no activity.
    expect(db.leads).toHaveLength(0);
    expect(db.activities).toHaveLength(0);
  });

  it("single-brand mode is unchanged: no picker, DEFAULT_BRAND written", async () => {
    db.brands = [{ ...MARLEY }];
    const res = await createLeadAction({ ...input, brand: "" });
    expect(res.ok).toBe(true);
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0].brand).toBe("marley");
  });

  it("multi-brand mode is unchanged: a valid pick is written, a missing pick refuses", async () => {
    const res = await createLeadAction(input);
    expect(res.ok).toBe(true);
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0].brand).toBe("pitmans");

    const missing = await createLeadAction({ ...input, brand: "" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/choose which brand/i);
  });
});

describe("updateLeadBrandAction and a failed brands read", () => {
  beforeEach(reset);

  it("refuses with the read error, not the misleading 'need more than one active brand'", async () => {
    db.leads = [{ id: LEAD, client_id: CLIENT, brand: "pitmans" }];
    brandsReadError = "connection reset";
    const res = await updateLeadBrandAction(LEAD, "marley");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/brand list/i);
      expect(res.error).not.toMatch(/more than one active brand/i);
    }
    expect(db.leads[0].brand).toBe("pitmans"); // untouched
  });
});
