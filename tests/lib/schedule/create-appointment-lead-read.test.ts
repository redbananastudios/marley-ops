import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * createAppointment discarded the error from its leads read and booked anyway.
 * The damage is worse than a lead-less row, because `lead_id: input.leadId` is
 * kept from the INPUT while everything derived from the read is not: the
 * appointment lands attached to the real enquiry but stamped
 * `brand: DEFAULT_BRAND`, with no client_id, no location, no linked survey row
 * and no status nudge — under a clean "Survey booked." toast. Nothing repairs
 * it later: `appointments.brand` is a denormalised column with no trigger tying
 * it to its parent lead (migration 0104), and the diary colours off that
 * column rather than a join.
 *
 * So a lead that was asked for and not returned refuses, whichever way the read
 * failed. The bare-client and no-lead paths are untouched.
 */

const LEAD = "44444444-4444-4444-8444-444444444444";

const db = {
  leadResult: {} as { data: unknown; error: { code?: string; message: string } | null },
  appointments: [] as Record<string, unknown>[],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;

function leadsChain(): Chain {
  const q: Chain = {};
  for (const m of ["select", "eq", "update", "is"]) q[m] = () => q;
  q.single = async () => db.leadResult;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
  return q;
}

function appointmentsChain(): Chain {
  const q: Chain = {};
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.insert = (row: Record<string, unknown>) => ({
    select: () => ({
      single: async () => {
        db.appointments.push(row);
        return { data: { id: "appt-1" }, error: null };
      },
    }),
  });
  return q;
}

function inertChain(): Chain {
  const q: Chain = {};
  for (const m of ["select", "eq", "neq", "order", "limit", "update", "insert", "is"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: null, error: null });
  q.single = async () => ({ data: null, error: null });
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
    from: (table: string) => {
      if (table === "leads") return leadsChain();
      if (table === "appointments") return appointmentsChain();
      return inertChain();
    },
  }),
}));

vi.mock("@/app/(dashboard)/comms-actions", () => ({ sendCommunication: vi.fn() }));
vi.mock("@/lib/comms/dispatch", () => ({ sendOpsAlert: vi.fn() }));
vi.mock("@/lib/schedule/notify-estimator", () => ({
  notifyEstimatorOfSurvey: vi.fn(),
  ukSlotLabel: () => "a slot",
}));
vi.mock("@/lib/leads/for-client", () => ({ ensureLeadForClient: vi.fn() }));

import { createAppointment } from "@/app/(dashboard)/schedule/actions";

const input = {
  apptType: "removal" as const,
  leadId: LEAD,
  startsAt: "2026-10-05T07:00:00.000Z",
  endsAt: "2026-10-05T16:00:00.000Z",
};

describe("createAppointment refuses when the lead it was given cannot be read", () => {
  beforeEach(() => {
    db.appointments = [];
  });

  it("a FAILED leads read books nothing — a mis-stamped row attached to the real lead is worse than no row", async () => {
    db.leadResult = { data: null, error: { message: "connection reset" } };
    const res = await createAppointment(input);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/could not read/i);
    expect(db.appointments).toHaveLength(0);
  });

  it("a MISSING lead refuses too", async () => {
    db.leadResult = { data: null, error: { code: "PGRST116", message: "0 rows" } };
    const res = await createAppointment(input);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no longer exists/i);
    expect(db.appointments).toHaveLength(0);
  });

  it("a readable lead books with ITS brand, as before", async () => {
    db.leadResult = {
      data: {
        id: LEAD,
        client_id: "client-1",
        status: "provisional",
        name: "A Customer",
        phone: null,
        email: null,
        from_address: "1 Test Street",
        from_postcode: null,
        brand: "pitmans",
      },
      error: null,
    };
    const res = await createAppointment(input);
    expect(res.ok).toBe(true);
    expect(db.appointments[0]).toMatchObject({
      brand: "pitmans",
      lead_id: LEAD,
      client_id: "client-1",
      location: "1 Test Street",
    });
  });
});
