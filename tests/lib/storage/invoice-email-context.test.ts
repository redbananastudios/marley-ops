import { describe, expect, it, beforeEach, vi } from "vitest";

/**
 * The two storage-invoice EMAIL sweeps — the pending-claim repair and the
 * un-emailed re-send — and the one rule they share: an invoice email is a
 * BRANDED document, so it may only go out when the brand behind it is known.
 *
 * The sweeps read the let, unit, site and client rows to word that email. Those
 * reads used to be consumed as `data ?? []` with no `.error` inspected, so a
 * transient PostgREST blip produced empty maps that read exactly like "this let
 * is Marley's, has no unit and no customer email" — and the send then stamps
 * `emailed_at`, so the mis-branded copy is the only one that customer ever gets.
 *
 * Everything below is asserted at the sendEmail CALL, because that is the
 * boundary the customer sees: which From, which Reply-To, which brand chrome,
 * and whether the message went at all.
 */

const mocks = vi.hoisted(() => ({
  sends: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/comms/send", () => ({
  sendEmail: vi.fn(async (input: Record<string, unknown>) => {
    mocks.sends.push(input);
    return { ok: true, providerId: "email-1" };
  }),
}));

vi.mock("@/lib/ledger", () => ({
  asProvider: (p: string | null | undefined) => p ?? null,
  configuredProvider: () => "zoho",
  createInvoice: vi.fn(),
  findOrCreateContact: vi.fn(),
  getInvoicePdfBase64: vi.fn(async () => "cGRm"),
  findInvoiceByReference: vi.fn(async () => ({
    invoiceId: "z1",
    invoiceNumber: "PMS-001",
    invoiceUrl: "https://books.example.test/1",
    total: 84,
  })),
}));

import { repairPendingStorageClaims, resendUnemailedStorageInvoices } from "@/lib/storage/raise-storage-invoices";

type QueryResult = { data: unknown[] | null; error: { message: string } | null };

const ok = (rows: unknown[]): QueryResult => ({ data: rows, error: null });
const fails = (message: string): QueryResult => ({ data: null, error: { message } });

/** Canned reads keyed by table, plus a record of every write attempted. `eq`
 *  filters are honoured so `getBrandOrDefault`'s slug lookup resolves for real
 *  — the brand a send speaks as is the whole subject of this file. */
function fakeAdmin(reads: Record<string, QueryResult>) {
  const writes: { table: string; op: string; payload: unknown }[] = [];
  const from = (table: string) => {
    let op = "select";
    let single = false;
    let payload: unknown = null;
    const eqs: [string, unknown][] = [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const q: any = {};
    for (const m of ["select", "in", "is", "not", "lt", "gt", "gte", "order", "limit", "neq", "or", "range"]) {
      q[m] = () => q;
    }
    q.eq = (c: string, v: unknown) => (eqs.push([c, v]), q);
    q.update = (p: unknown) => ((op = "update"), (payload = p), q);
    q.insert = (p: unknown) => ((op = "insert"), (payload = p), q);
    q.delete = () => ((op = "delete"), q);
    q.maybeSingle = () => ((single = true), q);
    q.single = () => ((single = true), q);
    q.then = (resolve: (v: { data: unknown; error: unknown }) => void) => {
      if (op !== "select") {
        writes.push({ table, op, payload });
        return resolve({ data: [], error: null });
      }
      const res = reads[table] ?? ok([]);
      if (res.error) return resolve({ data: single ? null : null, error: res.error });
      const rows = (res.data ?? []).filter((r) =>
        eqs.every(([c, v]) => (r as Record<string, unknown>)[c] === v),
      );
      return resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return q;
  };
  return { admin: { from } as never, writes };
}

const BRANDS = [
  { slug: "marley", name: "Marley Moves", short_name: "Marley", active: true },
  {
    slug: "pitmans",
    name: "Pitmans Removals & Storage",
    short_name: "Pitmans",
    hello_from: "info@pitmansremovals.co.uk",
    accounts_from: "accounts@pitmansremovals.co.uk",
    email_domain: "pitmansremovals.co.uk",
    phone: "01258 858564",
    active: true,
  },
];

/** One Pitmans crate let on storage-terms v2, its invoice raised but never
 *  emailed — the exact row the sweep exists for. */
const PITMANS_LET = { id: "L1", unit_id: "U1", brand: "pitmans", min_kind: "calendar_month" };
const UNITS = [{ id: "U1", code: "250-04", unit_type: "crate_250", site_id: "S1" }];
const SITES = [{ id: "S1", name: "Blandford Yard" }];
const CLIENTS = [{ id: "C1", display_name: "Greig James", email: "greig@example.test" }];

const UNEMAILED_ROW = {
  id: "si1",
  status: "sent",
  let_id: "L1",
  client_id: "C1",
  period_start: "2026-09-15",
  period_end: "2026-10-14",
  amount: 84,
  kind: "minimum",
  handling_amount: 0,
  zoho_invoice_id: "z1",
  zoho_invoice_number: "PMS-001",
  zoho_invoice_url: "https://books.example.test/1",
  invoice_provider: "zoho",
  created_at: "2026-09-15T07:00:00Z",
};

const PENDING_CLAIM = {
  id: "si1",
  status: "pending",
  let_id: "L1",
  client_id: "C1",
  period_start: "2026-09-15",
  period_end: "2026-10-14",
  amount: 84,
  kind: "minimum",
  handling_amount: 0,
  handling_event_ids: [],
  emailed_at: null,
};

const resendReads = (over: Record<string, QueryResult> = {}): Record<string, QueryResult> => ({
  storage_invoices: ok([UNEMAILED_ROW]),
  storage_lets: ok([PITMANS_LET]),
  storage_units: ok(UNITS),
  storage_sites: ok(SITES),
  clients: ok(CLIENTS),
  brands: ok(BRANDS),
  ...over,
});

const TODAY = { todayIso: "2026-09-16T08:00:00Z" };

beforeEach(() => {
  mocks.sends.length = 0;
});

describe("resendUnemailedStorageInvoices — a send it cannot brand is a send it must not make", () => {
  it("sends nothing when the storage_lets read fails, and says so", async () => {
    const { admin } = fakeAdmin(resendReads({ storage_lets: fails("canceling statement due to statement timeout") }));

    const result = await resendUnemailedStorageInvoices(admin, TODAY);

    // The whole point: no email left the building under the default brand.
    expect(mocks.sends).toHaveLength(0);
    expect(result.resent).toBe(0);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toContain("could not read the let/customer context");
    expect(result.alerts[0]).toContain("statement timeout");
    expect(result.alerts[0]).toMatch(/NOT emailed/);
  });

  it("does not claim 'no customer email on file' off a failed clients read", async () => {
    const { admin } = fakeAdmin(resendReads({ clients: fails("connection reset by peer") }));

    const result = await resendUnemailedStorageInvoices(admin, TODAY);

    expect(mocks.sends).toHaveLength(0);
    // The old text asserted a fact about the customer's record that nothing had
    // looked at — it sent the office to Zoho to fix a row that was never wrong.
    expect(result.alerts.join(" ")).not.toContain("has no customer email on file");
    expect(result.alerts[0]).toContain("connection reset by peer");
  });

  it("refuses a row whose let has been deleted, naming the by-hand remedy", async () => {
    const { admin } = fakeAdmin(resendReads({ storage_lets: ok([]) }));

    const result = await resendUnemailedStorageInvoices(admin, TODAY);

    expect(mocks.sends).toHaveLength(0);
    expect(result.resent).toBe(0);
    expect(result.alerts[0]).toContain("PMS-001");
    expect(result.alerts[0]).toContain("brand cannot be resolved");
  });

  it("sends a Pitmans bill as Pitmans, with Pitmans' own reply door", async () => {
    const { admin } = fakeAdmin(resendReads());

    const result = await resendUnemailedStorageInvoices(admin, TODAY);

    expect(result.resent).toBe(1);
    expect(result.alerts).toEqual([]);
    const send = mocks.sends[0];
    expect(send.from).toBe("Pitmans Removals & Storage <accounts@pitmansremovals.co.uk>");
    // Unset, NOT Marley's money desk: a marleymoves.co.uk Reply-To beside a
    // Pitmans From bounces the customer between two identities mid-thread.
    expect(send.replyTo).toBeUndefined();
    // The brand snapshot travels with the send so the fallback resolves to the
    // brand's own front door rather than Marley's.
    expect((send.brand as { slug: string }).slug).toBe("pitmans");
  });

  it("keeps Marley's accounts desk as the Reply-To for a Marley let", async () => {
    const { admin } = fakeAdmin(
      resendReads({ storage_lets: ok([{ ...PITMANS_LET, brand: "marley", min_kind: "days" }]) }),
    );

    await resendUnemailedStorageInvoices(admin, TODAY);

    expect(mocks.sends[0].from).toBe("Marley Moves <accounts@marleymoves.co.uk>");
    expect(mocks.sends[0].replyTo).toBe("accounts@marleymoves.co.uk");
  });

  it("words the minimum the way the signed agreement and the attached PDF do", async () => {
    const { admin } = fakeAdmin(resendReads());

    await resendUnemailedStorageInvoices(admin, TODAY);

    const html = mocks.sends[0].html as string;
    expect(html).toContain("one calendar month minimum");
    // The day count is the legacy 'days' wording and contradicts the PDF stapled
    // to this very email.
    expect(html).not.toContain("30-day minimum");
    // The unit label still resolves — the context read is all-or-nothing, so a
    // sent email is a fully described one.
    expect(html).toContain("250 cu ft crate 250-04 at Blandford Yard");
  });

  it("still says 'no customer email on file' when the read succeeded and the row is genuinely blank", async () => {
    const { admin } = fakeAdmin(resendReads({ clients: ok([{ id: "C1", display_name: "Greig James", email: null }]) }));

    const result = await resendUnemailedStorageInvoices(admin, TODAY);

    expect(mocks.sends).toHaveLength(0);
    expect(result.alerts[0]).toContain("has no customer email on file");
  });
});

describe("repairPendingStorageClaims — adopt the money, hold the email", () => {
  const repairReads = (over: Record<string, QueryResult> = {}): Record<string, QueryResult> => ({
    storage_invoices: ok([PENDING_CLAIM]),
    storage_lets: ok([PITMANS_LET]),
    storage_units: ok(UNITS),
    storage_sites: ok(SITES),
    clients: ok(CLIENTS),
    brands: ok(BRANDS),
    ...over,
  });

  it("completes the write-back but sends no email when the context read fails", async () => {
    const { admin, writes } = fakeAdmin(repairReads({ storage_lets: fails("statement timeout") }));

    const result = await repairPendingStorageClaims(admin, TODAY);

    // The money half is untouched — the invoice exists in the ledger and the
    // panel row must be linked to it either way.
    expect(result.adopted).toBe(1);
    expect(writes.some((w) => w.table === "storage_invoices" && w.op === "update")).toBe(true);
    // The branded half is held. `emailed_at` stays null, so the un-emailed
    // sweep re-sends it once the read recovers.
    expect(mocks.sends).toHaveLength(0);
    expect(result.alerts.join(" ")).toContain("NOT emailed");
  });

  it("sends the held email as the let's own brand once the context reads", async () => {
    const { admin } = fakeAdmin(repairReads());

    const result = await repairPendingStorageClaims(admin, TODAY);

    expect(result.adopted).toBe(1);
    expect(mocks.sends).toHaveLength(1);
    expect(mocks.sends[0].from).toBe("Pitmans Removals & Storage <accounts@pitmansremovals.co.uk>");
    expect(mocks.sends[0].html as string).toContain("one calendar month minimum");
  });
});
