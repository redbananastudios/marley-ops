import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Xero invoice and payment path, driven entirely off recorded response
 * fixtures — the shapes below are the ones the recon read back off the live
 * Demo Company on 2026-08-28, not invented ones. No test here touches Xero;
 * the credentials do not exist on this machine and never should.
 *
 * Three of these tests exist because a plausible implementation gets them
 * wrong and nothing throws:
 *
 *  - a reference that matches two live invoices must REFUSE, not pick one;
 *  - `invoiceCarriesVat` fed a list-shaped row must refuse rather than answer
 *    "no VAT", because that answer gates whether a credit note reverses VAT;
 *  - a write rejected inside an HTTP 200 must throw rather than read as done.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  /** Responses handed out in order, one per `xeroFetch` call. */
  queue: [] as Response[],
  /** Every call made, so a test can prove what was NOT sent as well as what was. */
  calls: [] as { path: string; init?: RequestInit; accept?: string }[],
  /** What the live-write guard sees. Demo unless a test says otherwise. */
  org: { class: "DEMO", isDemoCompany: true, name: "Demo Company (UK)" } as Record<string, unknown>,
  warnings: [] as { event: string; ctx: unknown }[],
}));

vi.mock("@/lib/ledger/xero-client", () => ({
  xeroFetch: vi.fn(async (path: string, init?: RequestInit, accept?: string) => {
    state.calls.push({ path, init, accept });
    const next = state.queue.shift();
    if (!next) throw new Error(`No fixture queued for xeroFetch(${path})`);
    return next;
  }),
  readOrganisation: vi.fn(async () => state.org),
}));

vi.mock("@/lib/log", () => ({
  log: {
    warn: (event: string, ctx: unknown) => state.warnings.push({ event, ctx }),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { LedgerError } from "@/lib/ledger/types";
import {
  createInvoice,
  findInvoiceByReference,
  getInvoicePdfBase64,
  getInvoiceStatus,
  idempotencyKey,
  invoiceAppUrl,
  invoiceCarriesVat,
  listInvoices,
  recordInvoicePayment,
  voidInvoice,
} from "@/lib/ledger/xero-invoices";

const BANK_ACCOUNT = "bd9e85e0-0478-433d-ae9f-0b3c4f04bfe4";
const INVOICE_ID = "318fbe79-1111-2222-3333-444455556666";

/** A Xero JSON response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One invoice row, in the shape a live read returns it. */
function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    InvoiceID: INVOICE_ID,
    InvoiceNumber: "INV-0052",
    Reference: "MMR001-DEP",
    Type: "ACCREC",
    Status: "AUTHORISED",
    Total: 120,
    SubTotal: 100,
    TotalTax: 20,
    AmountDue: 120,
    AmountPaid: 0,
    Date: "/Date(1780185600000+0000)/",
    DateString: "2026-05-31T00:00:00",
    Contact: { Name: "Greig James", ContactID: "c-1" },
    LineItems: [{ Description: "Deposit", TaxType: "OUTPUT2", TaxAmount: 20 }],
    ...over,
  };
}

/** The extra call `createInvoice` and the adopt path make for the hosted URL. */
const onlineUrl = () => json({ OnlineInvoices: [{ OnlineInvoiceUrl: "https://in.xero.com/ABC123" }] });

const ENV_KEYS = [
  "XERO_ACCOUNT_INCOME",
  "XERO_ACCOUNT_STORAGE_INCOME",
  "XERO_ACCOUNT_BANKTRANSFER",
  "XERO_TAX_TYPE_VAT",
  "XERO_TAX_TYPE_NO_VAT",
  "XERO_ORG_SHORTCODE",
  "XERO_BRANDING_THEME_DEFAULT",
  "XERO_ALLOW_LIVE_WRITES",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.XERO_ACCOUNT_INCOME = "200";
  process.env.XERO_ACCOUNT_BANKTRANSFER = BANK_ACCOUNT;
  process.env.XERO_TAX_TYPE_VAT = "OUTPUT2";
  process.env.XERO_TAX_TYPE_NO_VAT = "NONE";
  process.env.XERO_ORG_SHORTCODE = "!N7rJh";
  delete process.env.XERO_ACCOUNT_STORAGE_INCOME;
  delete process.env.XERO_BRANDING_THEME_DEFAULT;
  delete process.env.XERO_ALLOW_LIVE_WRITES;
  state.queue = [];
  state.calls = [];
  state.warnings = [];
  state.org = { class: "DEMO", isDemoCompany: true, name: "Demo Company (UK)" };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** The parsed body of the nth call, for asserting what we actually sent. */
function sentBody(index = 0): Record<string, unknown> {
  return JSON.parse(String(state.calls[index].init?.body ?? "{}"));
}

/* ------------------------------------------------- findInvoiceByReference */

describe("findInvoiceByReference — ambiguity yields nothing", () => {
  it("returns null on a miss, which arrives as a 200 with an empty array", async () => {
    state.queue.push(json({ Invoices: [] }));
    await expect(findInvoiceByReference("MMR001-DEP")).resolves.toBeNull();
  });

  it("maps the single match and fetches the hosted customer URL", async () => {
    state.queue.push(json({ Invoices: [invoiceRow()] }), onlineUrl());
    await expect(findInvoiceByReference("MMR001-DEP")).resolves.toEqual({
      invoiceId: INVOICE_ID,
      invoiceNumber: "INV-0052",
      invoiceUrl: "https://in.xero.com/ABC123",
      total: 120,
    });
  });

  /**
   * Xero does NOT enforce a unique Reference — the recon created three invoices
   * sharing one and read all three back through this same query. So `[0]` is
   * not a tidy shortcut, it is a coin flip about which invoice a customer's
   * money belongs to.
   */
  it("refuses when two live invoices share the reference", async () => {
    state.queue.push(
      json({
        Invoices: [
          invoiceRow({ InvoiceNumber: "INV-0052" }),
          invoiceRow({ InvoiceID: "other", InvoiceNumber: "INV-0053" }),
        ],
      }),
    );
    await expect(findInvoiceByReference("MMR001-DEP")).rejects.toThrow(LedgerError);
    state.queue.push(
      json({
        Invoices: [invoiceRow(), invoiceRow({ InvoiceID: "b", InvoiceNumber: "INV-0053" })],
      }),
    );
    await expect(findInvoiceByReference("MMR001-DEP")).rejects.toThrow(
      /2 live invoices with reference MMR001-DEP \(INV-0052, INV-0053\)/,
    );
  });

  it("returns the document's own due date, for adopters that must not invent one", async () => {
    // The adoption path stamps the ADOPTED document's due date onto the quote
    // (never today+terms — the client already holds a PDF naming this day).
    state.queue.push(
      json({
        Invoices: [
          invoiceRow({ DueDate: "/Date(1790640000000+0000)/", DueDateString: "2026-09-29T00:00:00" }),
        ],
      }),
      onlineUrl(),
    );
    const found = await findInvoiceByReference("MMR001-DEP");
    expect(found?.dueDate).toBe("2026-09-29");
  });

  it("omits the due date when the document carries none, so absence stays absence", async () => {
    state.queue.push(json({ Invoices: [invoiceRow()] }), onlineUrl());
    const found = await findInvoiceByReference("MMR001-DEP");
    expect(found && "dueDate" in found).toBe(false);
  });

  /** A voided document is still returned by a reference query — verified live. */
  it("skips voided and deleted matches", async () => {
    state.queue.push(
      json({
        Invoices: [
          invoiceRow({ InvoiceID: "dead-1", Status: "VOIDED" }),
          invoiceRow({ InvoiceID: "dead-2", Status: "DELETED" }),
          invoiceRow(),
        ],
      }),
      onlineUrl(),
    );
    const found = await findInvoiceByReference("MMR001-DEP");
    expect(found?.invoiceId).toBe(INVOICE_ID);
  });

  it("returns null when every match is voided", async () => {
    state.queue.push(json({ Invoices: [invoiceRow({ Status: "VOIDED" })] }));
    await expect(findInvoiceByReference("MMR001-DEP")).resolves.toBeNull();
  });

  /**
   * `searchTerm` is a case-insensitive SUBSTRING search across InvoiceNumber
   * and Reference, so `MMR001` would match `MMR0011-DEP` — and our references
   * are exactly the colliding shape.
   */
  it("queries with an exact where clause, never searchTerm, encoded once", async () => {
    state.queue.push(json({ Invoices: [] }));
    await findInvoiceByReference("MMR001-DEP");
    const path = state.calls[0].path;
    expect(path).toContain("Reference%3D%3D%22MMR001-DEP%22");
    expect(path).toContain("Type%3D%3D%22ACCREC%22");
    expect(path).not.toContain("searchTerm");
    // Double-encoding puts a literal % in front of Xero's filter parser.
    expect(path).not.toContain("%253D");
    // Form-encoded spaces would arrive as `+` rather than as a space.
    expect(path).not.toContain("+");
  });

  it("rejects a reference carrying a quote or a backslash before any call is made", async () => {
    await expect(findInvoiceByReference('MMR001" OR 1=1')).rejects.toThrow(LedgerError);
    expect(state.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ createInvoice */

describe("createInvoice", () => {
  const THEME_DEFAULT = "aa1e5a76-1e1a-4a1e-9e5a-761e1a4a1e9e";
  const THEME_NO_CARD = "bb2f6b87-2f2b-5b2f-8f6b-872f2b5b2f8f";

  /** Every create is preceded by the dead-invoice check (the idempotency salt
   *  — see "idempotency across a void-then-re-raise"), so the PUT is call [1]
   *  and its body is sentBody(1). This fixture answers "nothing dead". */
  const noDead = () => json({ Invoices: [] });

  /**
   * The card-fee decision, proved end to end.
   *
   * `disableOnlinePayments` exists because balance invoices are BACS/cash only —
   * card fees are too high at those values (Peter, 2026-07-09). Xero cannot
   * suppress card per invoice, so the ONLY expression of that decision is which
   * branding theme the invoice is raised under.
   *
   * Nothing tested this. The config module proved `xeroBrandingThemeId` computes
   * the right id in isolation, but nothing proved `createInvoice` asks it the
   * right question or puts the answer on the wire — so dropping the
   * `BrandingThemeID` spread, or misspelling the key, would leave tsc, eslint and
   * every other test green while every balance invoice quietly started offering
   * card at full fee.
   */
  it("raises a card-suppressed invoice under the no-card theme", async () => {
    process.env.XERO_CARD_ENABLED = "true";
    process.env.XERO_BRANDING_THEME_DEFAULT = THEME_DEFAULT;
    process.env.XERO_BRANDING_THEME_NO_CARD = THEME_NO_CARD;
    state.queue.push(noDead(), json({ Invoices: [invoiceRow()] }), onlineUrl());

    await createInvoice({
      customerId: "contact-guid",
      reference: "MMR001-BAL",
      description: "Balance",
      amount: 1450,
      disableOnlinePayments: true,
    });

    const invoice = (sentBody(1) as { Invoices: Record<string, unknown>[] }).Invoices[0];
    expect(invoice.BrandingThemeID).toBe(THEME_NO_CARD);
  });

  it("leaves an ordinary invoice on the default theme", async () => {
    process.env.XERO_CARD_ENABLED = "true";
    process.env.XERO_BRANDING_THEME_DEFAULT = THEME_DEFAULT;
    process.env.XERO_BRANDING_THEME_NO_CARD = THEME_NO_CARD;
    state.queue.push(noDead(), json({ Invoices: [invoiceRow()] }), onlineUrl());

    await createInvoice({
      customerId: "contact-guid",
      reference: "MMR001-DEP",
      description: "Deposit",
      amount: 120,
    });

    const invoice = (sentBody(1) as { Invoices: Record<string, unknown>[] }).Invoices[0];
    expect(invoice.BrandingThemeID).toBe(THEME_DEFAULT);
  });

  /**
   * We ASKED for AUTHORISED; an org with an approval workflow, or a connected
   * user on the "can't approve" role, returns DRAFT instead. Reporting that as a
   * successful raise emails the customer a request for an invoice carrying no
   * journals, and the failure only surfaces when the money arrives and the
   * payment write is refused.
   */
  it("refuses to report a raise that came back unapproved", async () => {
    state.queue.push(noDead(), json({ Invoices: [invoiceRow({ Status: "DRAFT" })] }), onlineUrl());
    await expect(
      createInvoice({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 120 }),
    ).rejects.toThrow(/not AUTHORISED/);
  });

  it("raises an approved, VAT-inclusive invoice in one call", async () => {
    state.queue.push(noDead(), json({ Invoices: [invoiceRow()] }), onlineUrl());
    const ref = await createInvoice({
      customerId: "contact-guid",
      reference: "MMR001-DEP",
      description: "Deposit",
      amount: 120,
    });

    const body = sentBody(1) as { Invoices: Record<string, unknown>[] };
    const invoice = body.Invoices[0];
    expect(state.calls[1].path).toBe("/Invoices");
    expect(state.calls[1].init?.method).toBe("PUT"); // POST is create-or-update
    expect(invoice.Type).toBe("ACCREC");
    // Omitting this adds 20% on top of a price the customer already agreed.
    expect(invoice.LineAmountTypes).toBe("Inclusive");
    // Without this the invoice stays DRAFT: no journals, no payments, no URL.
    expect(invoice.Status).toBe("AUTHORISED");
    expect(invoice.Reference).toBe("MMR001-DEP");
    // Anything beyond ContactID here EDITS the customer's contact record.
    expect(invoice.Contact).toEqual({ ContactID: "contact-guid" });

    const line = (invoice.LineItems as Record<string, unknown>[])[0];
    expect(line).toMatchObject({
      Description: "Deposit",
      Quantity: 1,
      UnitAmount: 120,
      AccountCode: "200",
      TaxType: "OUTPUT2",
    });
    // The LineItem schema has no Name field — the income handle is the account.
    expect("Name" in line).toBe(false);

    expect(ref).toEqual({
      invoiceId: INVOICE_ID,
      invoiceNumber: "INV-0052",
      invoiceUrl: "https://in.xero.com/ABC123",
    });
  });

  /**
   * Void-then-re-raise must never replay the voided create.
   *
   * The key used to derive from the reference ALONE, and the reference is
   * stable per slot (MMR001-DEP forever). So: raise at T0, mark the lead lost
   * by mistake at T+2min (voids the invoice), reopen at T+3min (clears the
   * slot ids so the raisers mint fresh), re-raise at T+4min — inside Xero's
   * 6-minute window the same key REPLAYS the cached T0 response: no new
   * invoice is created, the cached body still reads AUTHORISED (so the
   * post-create status assertion passes on stale data), and the app adopts
   * the VOIDED document. The customer is then emailed a payment link to an
   * invoice carrying no journals. `findInvoiceByReference`'s DEAD_STATUSES
   * filter cannot help — the replay happens inside Xero's HTTP layer, below
   * every code path we control. The dead documents under the reference are
   * therefore part of the write's identity: same live state ⇒ same key (a
   * timeout retry still deduplicates), a void in between ⇒ a new key.
   */
  describe("idempotency across a void-then-re-raise", () => {
    const voided = (id: string) => invoiceRow({ InvoiceID: id, InvoiceNumber: `INV-DEAD-${id}`, Status: "VOIDED" });

    /** The Idempotency-Key the create PUT carries, given what Xero already
     *  holds under the reference. Tolerant of a throw — the header is on the
     *  wire either way, and the wire is what Xero's replay keys on. */
    async function captureCreateKey(existing: unknown[]): Promise<string> {
      state.queue = [json({ Invoices: existing }), json({ Invoices: [invoiceRow()] }), onlineUrl()];
      state.calls = [];
      await createInvoice({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 120 }).catch(() => {});
      const put = state.calls.find((c) => c.init?.method === "PUT");
      expect(put, "no create PUT was sent").toBeTruthy();
      return (put!.init!.headers as Record<string, string>)["Idempotency-Key"];
    }

    it("a re-raise after a void sends a DIFFERENT key — the cached voided create must not replay", async () => {
      const fresh = await captureCreateKey([]);
      const afterVoid = await captureCreateKey([voided("dead-1")]);
      expect(afterVoid).not.toBe(fresh);
      // And a second void-re-raise cycle is distinct again.
      const afterSecondVoid = await captureCreateKey([voided("dead-1"), voided("dead-2")]);
      expect(afterSecondVoid).not.toBe(afterVoid);
      expect(afterSecondVoid).not.toBe(fresh);
    });

    it("a genuine retry of the SAME attempt keeps the same key — that is the entire point of the header", async () => {
      expect(await captureCreateKey([])).toBe(await captureCreateKey([]));
      expect(await captureCreateKey([voided("dead-1")])).toBe(await captureCreateKey([voided("dead-1")]));
    });

    it("control: an ordinary first raise sends the byte-identical key it always has", async () => {
      expect(await captureCreateKey([])).toBe(idempotencyKey("invoice-create|MMR001-DEP"));
    });

    it("with a voided document under the reference, the re-raise creates and reports the NEW invoice", async () => {
      state.queue = [
        json({ Invoices: [voided("dead-1")] }),
        json({ Invoices: [invoiceRow({ InvoiceID: "fresh-1", InvoiceNumber: "INV-0099" })] }),
        onlineUrl(),
      ];
      state.calls = [];
      const ref = await createInvoice({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 120 });
      expect(ref.invoiceId).toBe("fresh-1");
      expect(ref.invoiceNumber).toBe("INV-0099");
    });
  });

  /**
   * The header is capped at 128 characters and Xero's own recommendation
   * (four concatenated UUIDs) is 144 with the hyphens, which would 400.
   */
  it("sends an idempotency key inside Xero's 128-character cap", async () => {
    state.queue.push(noDead(), json({ Invoices: [invoiceRow()] }), onlineUrl());
    await createInvoice({
      customerId: "c",
      reference: "MMR001-DEP",
      description: "Deposit",
      amount: 120,
    });
    const headers = state.calls[1].init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
    expect(headers["Idempotency-Key"].length).toBeLessThanOrEqual(128);
    // DERIVED, not random. A random key per attempt is the failure this header
    // is supposed to prevent: Xero's 6-minute window only collapses a retry
    // carrying the SAME key, so a fresh one each time makes the header
    // decoration. The same logical write must always agree with itself...
    expect(idempotencyKey("invoice-create|MMR001-DEP")).toBe(idempotencyKey("invoice-create|MMR001-DEP"));
    // ...and two different writes must never collide.
    expect(idempotencyKey("invoice-create|MMR001-DEP")).not.toBe(idempotencyKey("invoice-create|MMR002-DEP"));
    expect(idempotencyKey("invoice-create|MMR001-DEP")).not.toBe(idempotencyKey("creditnote-create|MMR001-DEP"));
  });

  /**
   * Peter, 2026-08-27: the live Xero organisation is read-only until the
   * cutover. A refusal that still made the call would be no refusal at all.
   */
  it("refuses to write to a live organisation, and makes no call at all", async () => {
    state.org = { class: "COMPANY", isDemoCompany: false, name: "MarleyMoves Ltd" };
    await expect(
      createInvoice({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 120 }),
    ).rejects.toThrow(/READ-ONLY until the cutover/);
    expect(state.calls).toHaveLength(0);
  });

  /**
   * A null class means the org could not be identified. "I could not check"
   * must never render as "safe to write".
   */
  it("refuses when the organisation could not be read", async () => {
    state.org = { class: null };
    await expect(
      createInvoice({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 120 }),
    ).rejects.toThrow(LedgerError);
    expect(state.calls).toHaveLength(0);
  });

  it("names a scope refusal as a scope refusal, not as the cutover guard", async () => {
    state.org = { class: null, scopeDenied: true };
    await expect(
      createInvoice({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 120 }),
    ).rejects.toThrow(/accounting.settings.read/);
  });

  /** Xero invoices have no notes field; the notes are customer-facing prose. */
  it("carries the notes into the line description rather than dropping them", async () => {
    state.queue.push(noDead(), json({ Invoices: [invoiceRow()] }), onlineUrl());
    await createInvoice({
      customerId: "c",
      reference: "MMR001-DEP",
      description: "Deposit",
      amount: 120,
      notes: "Balance invoiced separately before move day.",
    });
    const line = (sentBody(1).Invoices as Record<string, unknown>[])[0];
    expect(String((line.LineItems as Record<string, unknown>[])[0].Description)).toContain(
      "Balance invoiced separately",
    );
  });

  /** Standing policy 2026-07-22: storage income never mixes with removals. */
  it("posts storage income to its own account when one is configured", async () => {
    process.env.XERO_ACCOUNT_STORAGE_INCOME = "260";
    state.queue.push(noDead(), json({ Invoices: [invoiceRow()] }), onlineUrl());
    await createInvoice({
      customerId: "c",
      reference: "MMS-001",
      description: "Storage",
      amount: 60,
      itemName: "Storage",
    });
    const line = (sentBody(1).Invoices as Record<string, unknown>[])[0];
    expect((line.LineItems as Record<string, unknown>[])[0].AccountCode).toBe("260");
  });

  /**
   * Storage income does NOT fall back to the general account.
   *
   * It used to, with a warning, on the reasoning that a reclassifiable invoice
   * beats stopping storage billing. That is the same "an unset variable is a
   * decision" mistake as the branding-theme one, and quieter: the invoice, the
   * total and the customer email are all correct, so the first person to notice
   * is the accountant at the quarter end with a month of storage income already
   * mixed into Removals Income. Under Zoho separation needed no configuration at
   * all, so a cutover losing it silently is a regression nobody asked for.
   */
  it("refuses to book storage income to the general account", async () => {
    await expect(
      createInvoice({
        customerId: "c",
        reference: "MMS-001",
        description: "Storage",
        amount: 60,
        itemName: "Storage",
      }),
    ).rejects.toThrow(/XERO_ACCOUNT_STORAGE_INCOME/);
    // And it refuses BEFORE writing anything, not after.
    expect(state.calls).toHaveLength(0);
  });

  it("uses the storage account when it is configured", async () => {
    process.env.XERO_ACCOUNT_STORAGE_INCOME = "201";
    state.queue.push(noDead(), json({ Invoices: [invoiceRow()] }), onlineUrl());
    await createInvoice({
      customerId: "c",
      reference: "MMS-001",
      description: "Storage",
      amount: 60,
      itemName: "Storage",
    });
    const line = (sentBody(1).Invoices as Record<string, unknown>[])[0];
    expect((line.LineItems as Record<string, unknown>[])[0].AccountCode).toBe("201");
  });

  /**
   * With `summarizeErrors=false` a REJECTED element arrives under HTTP 200. We
   * never send it — but a 200 that contains a failure must not read as success.
   */
  it("throws when the 200 carries a rejected element", async () => {
    state.queue.push(
      noDead(),
      json({
        Invoices: [
          {
            HasValidationErrors: true,
            ValidationErrors: [{ Message: "Account code 999 is not valid" }],
          },
        ],
      }),
    );
    await expect(
      createInvoice({ customerId: "c", reference: "MMR001-DEP", description: "d", amount: 120 }),
    ).rejects.toThrow(/Account code 999 is not valid/);
  });

  /**
   * The invoice exists by the time the hosted-URL call runs. Throwing would
   * discard a successful create over a missing email button.
   */
  it("still returns the invoice when the hosted URL cannot be fetched", async () => {
    state.queue.push(noDead(), json({ Invoices: [invoiceRow()] }), new Response("nope", { status: 500 }));
    const ref = await createInvoice({
      customerId: "c",
      reference: "MMR001-DEP",
      description: "d",
      amount: 120,
    });
    expect(ref.invoiceId).toBe(INVOICE_ID);
    expect(ref.invoiceUrl).toBeNull();
    expect(state.warnings.map((w) => w.event)).toContain("ledger.xero.online_invoice_url_failed");
  });
});

/* ------------------------------------------------------------- listInvoices */

describe("listInvoices", () => {
  it("maps rows and reads the date from DateString, not the /Date(ms)/ form", async () => {
    state.queue.push(
      json({ Invoices: [invoiceRow({ AmountDue: 70, AmountPaid: 50 })], pagination: { pageCount: 1 } }),
    );
    const list = await listInvoices({});
    expect(list.invoices[0]).toEqual({
      invoiceId: INVOICE_ID,
      invoiceNumber: "INV-0052",
      reference: "MMR001-DEP",
      customerName: "Greig James",
      date: "2026-05-31",
      status: "partially_paid",
      total: 120,
      balance: 70,
    });
    expect(list.truncated).toBe(false);
  });

  /**
   * Zoho's `Status.Unpaid` was sent + viewed + overdue + partially paid; under
   * Xero all four live inside AUTHORISED.
   */
  it("expresses the unpaid filter as Statuses=AUTHORISED", async () => {
    state.queue.push(json({ Invoices: [], pagination: { pageCount: 1 } }));
    await listInvoices({ status: "unpaid" });
    expect(state.calls[0].path).toContain("Statuses=AUTHORISED");
  });

  /**
   * There is no date_start/date_end parameter, and `dateEnd` is inclusive at
   * every call site while Xero's `<` is exclusive — so the bound is the day
   * after, or the last day of a VAT quarter silently vanishes.
   */
  it("builds an inclusive date window out of exclusive DateTime literals", async () => {
    state.queue.push(json({ Invoices: [], pagination: { pageCount: 1 } }));
    await listInvoices({ dateStart: "2026-08-01", dateEnd: "2026-08-31" });
    const where = decodeURIComponent(state.calls[0].path);
    expect(where).toContain("Date>=DateTime(2026,08,01)");
    expect(where).toContain("Date<DateTime(2026,09,01)");
  });

  it("reports truncation from Xero's own page count", async () => {
    state.queue.push(
      json({ Invoices: [invoiceRow()], pagination: { pageCount: 7 } }),
      json({ Invoices: [invoiceRow()], pagination: { pageCount: 7 } }),
    );
    const list = await listInvoices({});
    expect(list.truncated).toBe(true);
    expect(state.calls).toHaveLength(2); // the runaway cap, not the page count
  });

  /**
   * No pagination object means we cannot prove we saw everything. A money
   * figure built from a short list must SAY so rather than understate.
   */
  it("reports truncation when a full page arrives with no pagination to check", async () => {
    state.queue.push(json({ Invoices: Array.from({ length: 1000 }, () => invoiceRow()) }));
    const list = await listInvoices({});
    expect(list.truncated).toBe(true);
    expect(state.warnings.map((w) => w.event)).toContain("ledger.xero.list_pagination_missing");
  });
});

/* ------------------------------------------- getInvoiceStatus / carriesVat */

describe("getInvoiceStatus", () => {
  it("maps status, total and balance from a single read", async () => {
    state.queue.push(json({ Invoices: [invoiceRow({ Status: "PAID", AmountDue: 0, AmountPaid: 120 })] }));
    await expect(getInvoiceStatus(INVOICE_ID)).resolves.toEqual({
      invoiceId: INVOICE_ID,
      invoiceNumber: "INV-0052",
      // The hosted URL needs its own call and nothing downstream reads it off a
      // status poll — this runs on every open invoice on every cron pass.
      invoiceUrl: null,
      status: "paid",
      total: 120,
      balance: 0,
    });
  });

  /**
   * The 404 body is text/html, so a naive `res.json()` would throw a
   * SyntaxError and hide the real cause. A mis-routed poll must fail LOUDLY:
   * the alternative is a customer who HAS paid never being marked paid.
   */
  it("turns Xero's html 404 into a LedgerError, not a parse error", async () => {
    state.queue.push(
      new Response("The resource you're looking for cannot be found", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(getInvoiceStatus("123456789012345678")).rejects.toThrow(LedgerError);
  });

  it("logs a status it does not recognise instead of letting it pass silently", async () => {
    state.queue.push(json({ Invoices: [invoiceRow({ Status: "SOMETHING_NEW" })] }));
    const status = await getInvoiceStatus(INVOICE_ID);
    expect(status.status).toBe("SOMETHING_NEW"); // verbatim, never coerced
    expect(state.warnings.map((w) => w.event)).toContain("ledger.xero.unknown_invoice_status");
  });
});

/**
 * The live-money one. Xero's docs say a list read excludes LineItems; it does
 * not — the key is present with an EMPTY ARRAY. So `(inv.LineItems ?? []).some(...)`
 * over a list row returns `false` rather than throwing, `TotalTax > 0` still
 * covers the ordinary 20% case, and the ONLY case that breaks is zero-rated or
 * exempt — precisely the case the line check exists for. The answer gates
 * whether a credit note reverses VAT.
 */
describe("invoiceCarriesVat — the source row is the whole point", () => {
  it("reads the single-invoice endpoint, never a list", async () => {
    state.queue.push(json({ Invoices: [invoiceRow()] }));
    await invoiceCarriesVat(INVOICE_ID);
    expect(state.calls[0].path).toBe(`/Invoices/${INVOICE_ID}`);
    expect(state.calls[0].path).not.toContain("?");
  });

  it("is true for an ordinary 20% invoice", async () => {
    state.queue.push(json({ Invoices: [invoiceRow()] }));
    await expect(invoiceCarriesVat(INVOICE_ID)).resolves.toBe(true);
  });

  /** TotalTax is 0.00 at 0%, but the supply still belongs on the VAT return. */
  it("is true for a zero-rated supply, where TotalTax alone says nothing", async () => {
    state.queue.push(
      json({
        Invoices: [
          invoiceRow({
            TotalTax: 0,
            LineItems: [{ Description: "Export", TaxType: "ZERORATEDOUTPUT", TaxAmount: 0 }],
          }),
        ],
      }),
    );
    await expect(invoiceCarriesVat(INVOICE_ID)).resolves.toBe(true);
  });

  it("is false only when every line is explicitly NONE", async () => {
    state.queue.push(
      json({
        Invoices: [
          invoiceRow({
            TotalTax: 0,
            LineItems: [{ Description: "Pre-registration", TaxType: "NONE", TaxAmount: 0 }],
          }),
        ],
      }),
    );
    await expect(invoiceCarriesVat(INVOICE_ID)).resolves.toBe(false);
  });

  /**
   * The list-row shape, reaching the reader anyway. A confident "no VAT" here
   * is a wrong VAT reversal; a refusal is a human looking at it.
   */
  it("refuses rather than answering when the read carries no line items", async () => {
    state.queue.push(json({ Invoices: [invoiceRow({ TotalTax: 0, LineItems: [] })] }));
    await expect(invoiceCarriesVat(INVOICE_ID)).rejects.toThrow(/no line items/);
  });
});

/* --------------------------------------------------------------------- PDF */

describe("getInvoicePdfBase64", () => {
  /** The spec's `/Invoices/{id}/pdf` path 404s with an empty body. */
  it("asks for application/pdf on the ordinary invoice URL", async () => {
    state.queue.push(new Response(Buffer.from("%PDF-1.7 body"), { status: 200 }));
    const b64 = await getInvoicePdfBase64(INVOICE_ID);
    expect(state.calls[0].path).toBe(`/Invoices/${INVOICE_ID}`);
    expect(state.calls[0].path).not.toContain("/pdf");
    expect(state.calls[0].accept).toBe("application/pdf");
    expect(Buffer.from(b64, "base64").toString("latin1")).toBe("%PDF-1.7 body");
  });

  /** Without this, a JSON error body under a 200 gets emailed as an invoice. */
  it("refuses a 200 whose body is not actually a PDF", async () => {
    state.queue.push(json({ Invoices: [] }));
    await expect(getInvoicePdfBase64(INVOICE_ID)).rejects.toThrow(/is not a PDF/);
  });

  it("reports the empty-bodied 404 as a status rather than as nothing", async () => {
    state.queue.push(new Response(null, { status: 404 }));
    await expect(getInvoicePdfBase64(INVOICE_ID)).rejects.toThrow(/empty response body/);
  });
});

/* ---------------------------------------------------- payments and voiding */

describe("recordInvoicePayment", () => {
  /**
   * Xero has no payment-mode field: the ACCOUNT is the record of the rail, and
   * the wrong one books real customer money against the wrong nominal.
   */
  it("names the configured account id and carries no contact", async () => {
    state.queue.push(json({ Payments: [{ PaymentID: "pay-1" }] }));
    const id = await recordInvoicePayment({
      customerId: "contact-guid-that-xero-ignores",
      invoiceId: INVOICE_ID,
      amount: 50,
      mode: "banktransfer",
      reference: "MMR001-DEP",
      date: "2026-08-28",
    });
    expect(id).toBe("pay-1");
    expect(state.calls[0].path).toBe("/Payments");
    const payment = (sentBody().Payments as Record<string, unknown>[])[0];
    expect(payment).toEqual({
      Invoice: { InvoiceID: INVOICE_ID },
      Account: { AccountID: BANK_ACCOUNT },
      Amount: 50,
      Date: "2026-08-28",
      Reference: "MMR001-DEP",
    });
    expect(JSON.stringify(payment)).not.toContain("contact-guid-that-xero-ignores");
  });

  /**
   * The key derives from invoice|amount|date, so two GENUINELY DISTINCT
   * payments of the same amount on the same invoice on the same day collided
   * inside Xero's ~6-minute replay window: the second PUT replayed the first's
   * cached response and the second payment was silently never recorded. A
   * caller that can tell its payments apart (a bank transaction id, a
   * card_payments row id) salts the key; a timeout retry of the SAME payment
   * carries the same salt and still deduplicates. Same pattern as
   * createInvoice's void-aware key: absent ⇒ byte-identical to the old key.
   */
  it("distinct same-shaped payments carry distinct idempotency keys; the same one replays", async () => {
    const keyOf = async (paymentIdentity?: string) => {
      state.calls.length = 0;
      state.queue.push(json({ Payments: [{ PaymentID: "pay-x" }] }));
      await recordInvoicePayment({
        customerId: "c",
        invoiceId: INVOICE_ID,
        amount: 50,
        mode: "banktransfer",
        date: "2026-09-02",
        ...(paymentIdentity ? { paymentIdentity } : {}),
      });
      return (state.calls[0].init!.headers as Record<string, string>)["Idempotency-Key"];
    };
    // No distinct identity → the key is byte-identical to what it always was.
    expect(await keyOf()).toBe(idempotencyKey(`payment|${INVOICE_ID}|50|2026-09-02`));
    // Two distinct payments must not collide…
    expect(await keyOf("bank-tx-1")).not.toBe(await keyOf("bank-tx-2"));
    expect(await keyOf("bank-tx-1")).not.toBe(await keyOf());
    // …while a retry of the SAME payment still deduplicates.
    expect(await keyOf("bank-tx-1")).toBe(await keyOf("bank-tx-1"));
  });

  /** The Demo Company has no cash account at all, so this must fail closed. */
  it("refuses a rail with no configured account, naming the variable to set", async () => {
    await expect(
      recordInvoicePayment({ customerId: "c", invoiceId: INVOICE_ID, amount: 10, mode: "cash" }),
    ).rejects.toThrow(/XERO_ACCOUNT_CASH/);
    expect(state.calls).toHaveLength(0);
  });

  it("refuses to record a payment against live books", async () => {
    state.org = { class: "COMPANY", isDemoCompany: false, name: "MarleyMoves Ltd" };
    await expect(
      recordInvoicePayment({
        customerId: "c",
        invoiceId: INVOICE_ID,
        amount: 50,
        mode: "banktransfer",
      }),
    ).rejects.toThrow(/READ-ONLY until the cutover/);
    expect(state.calls).toHaveLength(0);
  });
});

describe("voidInvoice", () => {
  it("voids an unpaid invoice", async () => {
    state.queue.push(
      json({ Invoices: [invoiceRow()] }),
      json({ Invoices: [invoiceRow({ Status: "VOIDED", AmountDue: 120 })] }),
    );
    await expect(voidInvoice(INVOICE_ID)).resolves.toBeUndefined();
    expect(state.calls[1].init?.method).toBe("POST");
    expect((sentBody(1).Invoices as Record<string, unknown>[])[0].Status).toBe("VOIDED");
  });

  it("is a no-op on an invoice that is already void", async () => {
    state.queue.push(json({ Invoices: [invoiceRow({ Status: "VOIDED" })] }));
    await expect(voidInvoice(INVOICE_ID)).resolves.toBeUndefined();
    expect(state.calls).toHaveLength(1); // read only, no write
  });

  /**
   * This exact string is read by a human in an ops alert and is pinned by the
   * Zoho tests. It must survive the seam byte for byte, and it must not become
   * Xero's own wording.
   */
  it("refuses with the ops-alert wording when money has already landed", async () => {
    state.queue.push(json({ Invoices: [invoiceRow({ AmountDue: 70, AmountPaid: 50 })] }));
    await expect(voidInvoice(INVOICE_ID)).rejects.toThrow(
      "Refusing to void INV-0052: payment already applied",
    );
    expect(state.calls).toHaveLength(1);
  });

  /** Xero's own refusal is the belt-and-braces second line, carried verbatim. */
  it("surfaces Xero's validation refusal as display text", async () => {
    state.queue.push(
      json({ Invoices: [invoiceRow()] }),
      json(
        {
          ErrorNumber: 10,
          Type: "ValidationException",
          Message: "A validation exception occurred",
          Elements: [
            { ValidationErrors: [{ Message: "Invoice not of valid status for modification" }] },
          ],
        },
        400,
      ),
    );
    await expect(voidInvoice(INVOICE_ID)).rejects.toThrow(
      /Invoice not of valid status for modification/,
    );
  });

  /** A 200 that did not actually void must not report success. */
  it("refuses to report a void that did not happen", async () => {
    state.queue.push(
      json({ Invoices: [invoiceRow()] }),
      json({ Invoices: [invoiceRow({ Status: "AUTHORISED" })] }),
    );
    await expect(voidInvoice(INVOICE_ID)).rejects.toThrow(/refusing to report it as voided/i);
  });
});

/* ---------------------------------------------------------- the deep link */

describe("invoiceAppUrl", () => {
  it("builds the office deep link from the configured org short code", () => {
    // The legacy `organisationlogin ... /AccountsReceivable/View.aspx` form was
    // REFUTED: the string "AccountsReceivable" appears nowhere in Xero's own
    // published source, and the 302 offered as proof it worked reproduces
    // identically for a garbage path and a bogus short code — so it evidenced
    // only that an anonymous hit bounces to login. This form is in Xero's source.
    expect(invoiceAppUrl(INVOICE_ID)).toBe(
      `https://go.xero.com/app/!N7rJh/invoicing/view/${INVOICE_ID}`,
    );
  });

  /**
   * Synchronous by contract — it renders inside JSX — so it cannot throw and it
   * cannot fetch. With no short code it must be obviously dead rather than a
   * link that looks valid and opens the WRONG organisation.
   */
  it("returns something inert, never a plausible URL, when the short code is unset", () => {
    delete process.env.XERO_ORG_SHORTCODE;
    const url = invoiceAppUrl(INVOICE_ID);
    expect(url).not.toContain("go.xero.com");
    expect(url.startsWith("#")).toBe(true);
  });
});

/* ------------------------------------------------------- the error taxonomy */

describe("error taxonomy", () => {
  /**
   * A fourth error type the first recon pass reported as an HTML body and the
   * re-probe found is JSON. A parser that only names ValidationException
   * degrades this to a raw 300-character slice.
   */
  it("reads a QueryParseException rather than dumping the raw body", async () => {
    state.queue.push(
      json(
        {
          ErrorNumber: 16,
          Type: "QueryParseException",
          Message: "Where clause invocation error: StartsWith",
        },
        400,
      ),
    );
    await expect(findInvoiceByReference("MMR001-DEP")).rejects.toThrow(
      /QueryParseException: Where clause invocation error/,
    );
  });

  /** A rate-limited cron must look rate-limited, not like a provider outage. */
  it("surfaces Retry-After on a 429", async () => {
    state.queue.push(
      new Response("", { status: 429, headers: { "retry-after": "37" } }),
    );
    await expect(findInvoiceByReference("MMR001-DEP")).rejects.toThrow(/retry after 37s/);
  });
});
