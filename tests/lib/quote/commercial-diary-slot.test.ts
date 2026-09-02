import { describe, expect, it, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * A confirmed commercial job had no diary entry at all.
 *
 * `ensureRemovalAppointment` had exactly two callers — `markDepositPaid` and
 * `confirmMoveDate` — and a commercial booking reaches neither: it rings no
 * deposit (PRD §3.10), so nothing ever marks one paid, and `confirmMoveDate`
 * hard-refuses while `deposit_paid_at` is null. The office accept IS the
 * confirmation for commercial, so it is the only moment the slot can be booked.
 *
 * What the missing row costs is not cosmetic: the post-move sweep, the crew day
 * sheet, crew sign-off and auto-completion all key on an `appt_type='removal'`
 * appointment, and completion is the sole trigger for the commercial invoice —
 * so the job sits awaiting completion for ever while its day still reads free
 * to the next booking.
 */

const QUOTE_ID = "q-commercial-1";
const LEAD_ID = "l-commercial-1";

const ensureRemovalAppointment = vi.fn(
  async (sb: unknown, quote: { id: string; lead_id: string | null }) => {
    void sb;
    return { created: true as const, appointmentId: `appt-${quote.id}` };
  },
);
vi.mock("@/lib/schedule/ensure-removal-appointment", () => ({
  ensureRemovalAppointment: (sb: unknown, quote: { id: string; lead_id: string | null }) =>
    ensureRemovalAppointment(sb, quote),
}));
vi.mock("@/lib/settings", () => ({
  getBusinessSettings: async () => ({ defaultDeposit: 100, smallJobThreshold: 0 }),
}));
vi.mock("@/lib/comms/dispatch", () => ({ dispatchComm: vi.fn(), sendOpsAlert: vi.fn() }));

/** The stored quote — the accept UPDATE merges into it, so the re-reads that
 *  follow (ensureDepositInvoice's commercial guard) see the row as written. */
const db = { quote: {} as Record<string, unknown> };

function resetQuote(over: Record<string, unknown> = {}) {
  db.quote = {
    id: QUOTE_ID,
    quote_ref: "PMC001",
    status: "sent",
    source: "ops",
    brand: "pitmans",
    payment_policy: null,
    lead_id: LEAD_ID,
    client_id: "client-1",
    customer_name: "A Business Ltd",
    customer_email: null,
    customer_phone: null,
    moving_date: "2027-10-05", // far outside T-7, so no late-booking balance
    vat_enabled: true,
    grand_total: 2400,
    agreed_price: null,
    accepted_at: null,
    accept_token: "tok-1234567890",
    deposit_amount: null,
    deposit_paid_at: null,
    declined_at: null,
    booking_cancelled_at: null,
    zoho_deposit_invoice_id: null,
    zoho_balance_invoice_id: null,
    zoho_commitment_invoice_id: null,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;

function chainFor(table: string): Chain {
  const c: Chain = {};
  let patch: Record<string, unknown> | null = null;
  let isUpdate = false;
  for (const m of ["select", "eq", "neq", "in", "is", "order", "limit"]) c[m] = () => c;
  c.update = (p: Record<string, unknown>) => {
    isUpdate = true;
    patch = p;
    return c;
  };
  c.insert = () => c;
  const rows = () => {
    if (table === "quotes" && isUpdate) {
      Object.assign(db.quote, patch ?? {});
      return [{ id: QUOTE_ID }]; // the CAS winner
    }
    return [];
  };
  const one = () => {
    if (table === "quotes") return { ...db.quote };
    if (table === "clients") return { is_company: true };
    if (table === "leads") return { status: "provisional", client_id: "client-1", first_contacted_at: null };
    return null;
  };
  c.maybeSingle = async () => ({ data: one(), error: null });
  c.single = async () => ({ data: one(), error: null });
  c.then = (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows(), error: null }).then(ok, no);
  return c;
}

const sb = { from: (table: string) => chainFor(table) } as unknown as SupabaseClient<Database>;

import { acceptQuoteByStaff } from "@/lib/quote/accept-flow";

describe("office-confirming a COMMERCIAL booking puts it in the diary", () => {
  beforeEach(() => {
    ensureRemovalAppointment.mockClear();
    resetQuote();
  });

  it("books the removal slot on accept — the only moment commercial ever can", async () => {
    const res = await acceptQuoteByStaff(sb, QUOTE_ID, "office-1");
    expect(res.ok).toBe(true);
    expect(ensureRemovalAppointment).toHaveBeenCalledTimes(1);
    expect(ensureRemovalAppointment.mock.calls[0]?.[1]).toMatchObject({ id: QUOTE_ID, lead_id: LEAD_ID });
  });

  it("self-heals a commercial booking accepted before this call existed", async () => {
    // Re-running the office action is the one repair path that needs no data
    // surgery, so the already-accepted branch books the slot too. Idempotent:
    // ensureRemovalAppointment refuses to touch a lead that already has a live
    // removal.
    resetQuote({ status: "accepted", payment_policy: "commercial", agreed_price: 2400, deposit_amount: 0 });
    const res = await acceptQuoteByStaff(sb, QUOTE_ID, "office-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.alreadyAccepted).toBe(true);
    expect(ensureRemovalAppointment).toHaveBeenCalledTimes(1);
  });

  it("a RESIDENTIAL accept still books nothing — its slot follows the deposit", async () => {
    // Unchanged behaviour, and deliberately so: a residential day is confirmed
    // by money landing, not by the office saying yes, so booking here would put
    // an unpaid job on the board.
    const residential = {
      from: (table: string) => {
        const c = chainFor(table);
        if (table === "clients") c.maybeSingle = async () => ({ data: { is_company: false }, error: null });
        return c;
      },
    } as unknown as SupabaseClient<Database>;
    const res = await acceptQuoteByStaff(residential, QUOTE_ID, "office-1");
    expect(res.ok).toBe(true);
    expect(ensureRemovalAppointment).not.toHaveBeenCalled();
  });
});
