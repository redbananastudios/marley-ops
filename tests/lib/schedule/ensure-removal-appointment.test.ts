import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureRemovalAppointment } from "@/lib/schedule/ensure-removal-appointment";

const QUOTE = {
  id: "q-1",
  lead_id: "lead-1",
  client_id: "client-1",
  estimator_id: "est-1",
  customer_name: "Rebecca Eldred",
  moving_date: "2026-08-21",
  source: "marley_ops",
};

/**
 * Minimal supabase double: `appointments` answers the existence probe with
 * `existing`, records the insert, and `leads` answers the address lookup.
 */
function client(opts: { existing?: { id: string } | null; insertError?: string; lookupError?: string } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const from = vi.fn((table: string) => {
    if (table === "appointments") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              neq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: opts.existing ?? null,
                    error: opts.lookupError ? { message: opts.lookupError } : null,
                  }),
                }),
              }),
            }),
          }),
        }),
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            select: () => ({
              single: async () => ({
                data: opts.insertError ? null : { id: "appt-new" },
                error: opts.insertError ? { message: opts.insertError } : null,
              }),
            }),
          };
        },
      };
    }
    // leads
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { name: "Rebecca Eldred", from_address: "12 Bell St, Shaftesbury", from_postcode: "SP7 8AA", client_id: "client-1" },
            error: null,
          }),
        }),
      }),
    };
  });
  return { sb: { from } as never, inserted };
}

describe("ensureRemovalAppointment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("books the diary slot at 08:00-17:00 UK when the lead has none", async () => {
    const { sb, inserted } = client();
    const res = await ensureRemovalAppointment(sb, QUOTE);

    expect(res).toEqual({ created: true, appointmentId: "appt-new" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      appt_type: "removal",
      lead_id: "lead-1",
      status: "scheduled",
      all_day: false,
      title: "Removal — Rebecca Eldred",
      location: "12 Bell St, Shaftesbury",
    });
    // August = BST, so 08:00 UK is 07:00Z and 17:00 UK is 16:00Z.
    expect(inserted[0].starts_at).toBe("2026-08-21T07:00:00.000Z");
    expect(inserted[0].ends_at).toBe("2026-08-21T16:00:00.000Z");
  });

  it("is idempotent — an existing live removal is never duplicated or re-dated", async () => {
    const { sb, inserted } = client({ existing: { id: "appt-existing" } });
    const res = await ensureRemovalAppointment(sb, QUOTE);
    expect(res).toEqual({ created: false, reason: "exists" });
    expect(inserted).toHaveLength(0);
  });

  it("skips legacy iMVE quotes — the importer books their slot and they are hands-off", async () => {
    const { sb, inserted } = client();
    const res = await ensureRemovalAppointment(sb, { ...QUOTE, source: "imve" });
    expect(res).toEqual({ created: false, reason: "legacy" });
    expect(inserted).toHaveLength(0);
  });

  it("never invents a date — no move date means no booking", async () => {
    const { sb, inserted } = client();
    for (const moving_date of [null, "", "soon", "21/08/2026"]) {
      const res = await ensureRemovalAppointment(sb, { ...QUOTE, moving_date });
      expect(res).toEqual({ created: false, reason: "no_date" });
    }
    expect(inserted).toHaveLength(0);
  });

  it("reports failure instead of throwing, so a diary error can never roll back a payment", async () => {
    const { sb } = client({ insertError: "boom" });
    await expect(ensureRemovalAppointment(sb, QUOTE)).resolves.toEqual({ created: false, reason: "error" });

    const lookupFailed = client({ lookupError: "unreachable" });
    await expect(ensureRemovalAppointment(lookupFailed.sb, QUOTE)).resolves.toEqual({ created: false, reason: "error" });
    // A failed existence probe must NOT fall through into a blind insert.
    expect(lookupFailed.inserted).toHaveLength(0);
  });

  it("does nothing for a quote with no lead", async () => {
    const { sb, inserted } = client();
    const res = await ensureRemovalAppointment(sb, { ...QUOTE, lead_id: null });
    expect(res).toEqual({ created: false, reason: "no_lead" });
    expect(inserted).toHaveLength(0);
  });
});
