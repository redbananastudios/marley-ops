import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resolving a customer to a Xero contact is the one place in the adapter where
 * being wrong does not fail — it succeeds against the wrong person. So most of
 * what follows tests refusals: two matches, an archived contact, a merged
 * contact, an unrecognised status. Every one of those is a state the Demo
 * Company was observed in on 2026-08-28, not a hypothetical.
 *
 * Fixtures only. No test here reaches Xero: the credentials live on the staging
 * box and a unit suite that needed them would simply not run.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  xeroFetch: vi.fn(),
  readOrganisation: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/ledger/xero-client", () => ({
  xeroFetch: mocks.xeroFetch,
  readOrganisation: mocks.readOrganisation,
}));

vi.mock("@/lib/log", () => ({
  log: { info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import { LedgerError } from "@/lib/ledger";
import { findOrCreateXeroContact, xeroContactNumber } from "@/lib/ledger/xero-contacts";

const CLIENT_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const QUOTE_ID = "99887766-5544-4332-8110-aabbccddeeff";
const CONTACT_ID = "22db7321-c095-435b-bba4-e0c69ab4f598";
const OTHER_CONTACT_ID = "1a06870d-7e8d-44d5-bf45-c7faf0164bf2";

const client = { kind: "client", id: CLIENT_ID } as const;
const quote = { kind: "quote", id: QUOTE_ID } as const;

const customer = { name: "John Smith", email: "john@example.com", phone: "07572382366" };

/** Xero answers JSON on everything except a 404, which is text/html prose. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function html(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function contacts(...rows: Record<string, unknown>[]): Response {
  return json(200, { Contacts: rows });
}

/** Xero's validation envelope, verbatim in shape. */
function validationError(...messages: string[]): Response {
  return json(400, {
    ErrorNumber: 10,
    Type: "ValidationException",
    Message: "A validation exception occurred",
    Elements: [
      { HasValidationErrors: true, ValidationErrors: messages.map((Message) => ({ Message })) },
    ],
  });
}

const active = {
  ContactID: CONTACT_ID,
  ContactStatus: "ACTIVE",
  Name: "John Smith",
};

/** The requests the module issued, in order: `[path, init]` per call. */
function requests(): { path: string; method: string; body: Record<string, unknown> | null }[] {
  const calls = mocks.xeroFetch.mock.calls as [string, RequestInit | undefined][];
  return calls.map(([path, init]) => ({
    path,
    method: init?.method ?? "GET",
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
  }));
}

function firstContactSent(index: number): Record<string, unknown> {
  const sent = requests()[index].body as { Contacts: Record<string, unknown>[] };
  return sent.Contacts[0];
}

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: clearing wipes the recorded calls but
  // LEAVES the queued `mockResolvedValueOnce` responses, so a test that refuses
  // early would hand its unconsumed fixtures to the next one — and the next one
  // would pass or fail for reasons that have nothing to do with it.
  vi.resetAllMocks();
  // The Demo Company, which is what staging talks to. The live-write guard is
  // NOT mocked out anywhere in this file — it runs for real.
  mocks.readOrganisation.mockResolvedValue({
    class: "DEMO",
    isDemoCompany: true,
    name: "Demo Company (UK)",
  });
});

describe("xeroContactNumber — the key, and why the prefixes differ", () => {
  it("keys a client and a quote under DIFFERENT prefixes", () => {
    expect(xeroContactNumber(client)).toBe(`MMOPS-${CLIENT_ID}`);
    expect(xeroContactNumber(quote)).toBe(`MMOPSQ-${QUOTE_ID}`);
  });

  /**
   * The failure a shared prefix would allow: a customer keyed on a quote id
   * before they had a client row, then keyed on the client id afterwards, would
   * resolve the older contact and merge the two identity spines on the wrong
   * side. A client key must never match a quote-keyed contact even if the two
   * ids were somehow identical.
   */
  it("cannot collide across kinds even on an identical id", () => {
    const a = xeroContactNumber({ kind: "client", id: CLIENT_ID });
    const b = xeroContactNumber({ kind: "quote", id: CLIENT_ID });
    expect(a).not.toBe(b);
    expect(b.startsWith(a)).toBe(false);
  });

  it("stays inside Xero's 50-character ContactNumber cap", () => {
    expect(xeroContactNumber(client).length).toBeLessThanOrEqual(50);
    expect(xeroContactNumber(quote).length).toBeLessThanOrEqual(50);
  });
});

describe("step 1 — our own key", () => {
  it("resolves an active contact, and asks Xero with an exact where clause", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(contacts(active));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).resolves.toBe(CONTACT_ID);

    const [lookup] = requests();
    expect(lookup.method).toBe("GET");
    expect(decodeURIComponent(lookup.path)).toContain(`ContactNumber=="MMOPS-${CLIENT_ID}"`);
    // Paged, because `MergedToContactID` is "only returned when using paging".
    expect(lookup.path).toContain("page=1");
    // Archived contacts are visible here on purpose — an archived contact holding
    // our key is a wedge we must SEE rather than fall past into a doomed create.
    expect(lookup.path).toContain("includeArchived=true");
    expect(mocks.xeroFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * Reachable, not theoretical: the Demo Company holds two ACTIVE contacts
   * sharing one ContactNumber, and the `GET /Contacts/{ContactNumber}` path form
   * returns HTTP 200 with one of them, silently ranking. Ambiguity yields
   * nothing.
   */
  it("refuses when two contacts share our key, and creates nothing", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(
      contacts(active, { ...active, ContactID: OTHER_CONTACT_ID }),
    );

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /refusing to choose one/i,
    );
    expect(mocks.xeroFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * The one-way wedge. Writing to an archived contact is rejected by Xero,
   * un-archiving is impossible through the API, and the key can never be
   * reissued — so the only honest output is a refusal naming the UI action.
   */
  it("refuses an ARCHIVED contact and names the Xero UI fix", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(contacts({ ...active, ContactStatus: "ARCHIVED" }));

    const err = await findOrCreateXeroContact({ ...customer, party: client }).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err.message).toMatch(/un-archived through the API/);
    expect(err.message).toMatch(/Xero UI/);
    // Not a create, either: the key stays reserved across archived contacts, so
    // a replacement would collide on it forever.
    expect(mocks.xeroFetch).toHaveBeenCalledTimes(1);
  });

  /** A human clicking Merge in Xero needs no code change on our side to happen. */
  it("refuses a contact that was merged away", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(
      contacts({ ...active, MergedToContactID: OTHER_CONTACT_ID }),
    );

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /MERGED into/,
    );
  });

  /** `ContactStatus` is a THREE-value enum; the summary docs show two. */
  it("refuses a GDPRREQUEST contact", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(contacts({ ...active, ContactStatus: "GDPRREQUEST" }));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /GDPR erasure request/,
    );
  });

  it("preserves an unrecognised status verbatim rather than assuming it is fine", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(contacts({ ...active, ContactStatus: "SOMETHING_NEW" }));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /unrecognised ContactStatus "SOMETHING_NEW"/,
    );
  });
});

describe("step 2 — email adoption", () => {
  it("adopts exactly one active match and stamps our key onto it", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts()) // no match on our key
      .mockResolvedValueOnce(contacts(active)) // one match on email
      .mockResolvedValueOnce(contacts({ ...active, ContactNumber: `MMOPS-${CLIENT_ID}` })); // the stamp

    await expect(findOrCreateXeroContact({ ...customer, party: client })).resolves.toBe(CONTACT_ID);

    const [, byEmail, stamp] = requests();
    expect(decodeURIComponent(byEmail.path)).toContain(`EmailAddress=="john@example.com"`);
    // The one POST in the module, and it carries our own ContactID — a
    // deliberate update of a known row, not a name match that could retarget.
    expect(stamp.method).toBe("POST");
    expect(stamp.body).toEqual({
      Contacts: [{ ContactID: CONTACT_ID, ContactNumber: `MMOPS-${CLIENT_ID}` }],
    });
  });

  /**
   * Xero's own best-practice guidance: a contact may already carry a
   * ContactNumber from another integration, and the field holds exactly one
   * value. Blind-stamping would break that system silently.
   */
  it("never overwrites a ContactNumber another integration set", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts({ ...active, ContactNumber: "SAGE-000123" }));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).resolves.toBe(CONTACT_ID);
    expect(requests().every((r) => r.method === "GET")).toBe(true);
  });

  it("refuses two email matches — adopting nothing and creating nothing", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts(active, { ...active, ContactID: OTHER_CONTACT_ID }));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /a human must decide which is the customer/,
    );
    expect(mocks.xeroFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * A failed stamp is a lost optimisation, not a lost invoice: the adopted
   * contact is correct either way, so this degrades and logs rather than failing
   * a money path. It logs because a branch that quietly stops working is the
   * shape this codebase keeps getting bitten by.
   */
  it("still returns the adopted contact when the stamp is refused", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts(active))
      .mockResolvedValueOnce(validationError("The contact number is already assigned"));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).resolves.toBe(CONTACT_ID);
    expect(mocks.warn).toHaveBeenCalledWith(
      "ledger.xero.contact.stamp_failed",
      expect.objectContaining({ contactId: CONTACT_ID }),
    );
  });

  /**
   * Only a doubled `""` parses inside a Xero where clause; a backslash escape
   * returns 400. Rather than lean on an undocumented quoting rule on a query
   * that decides who gets billed, an unquotable email skips the lookup. The cost
   * is a possible duplicate contact — fragmentation, visible and fixable — never
   * a mis-billing.
   */
  it("skips the email step for a value it cannot safely quote", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts({ ...active, ContactID: OTHER_CONTACT_ID }));

    await expect(
      findOrCreateXeroContact({ ...customer, email: 'we"ird@example.com', party: client }),
    ).resolves.toBe(OTHER_CONTACT_ID);

    const issued = requests();
    expect(issued).toHaveLength(2);
    expect(issued[1].method).toBe("PUT");
    expect(mocks.warn).toHaveBeenCalledWith(
      "ledger.xero.contact.email_unqueryable",
      expect.objectContaining({ contactNumber: `MMOPS-${CLIENT_ID}` }),
    );
  });

  it("skips the email step entirely when there is no email", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts({ ...active, ContactID: OTHER_CONTACT_ID }));

    await expect(
      findOrCreateXeroContact({ name: "John Smith", email: null, party: client }),
    ).resolves.toBe(OTHER_CONTACT_ID);
    expect(requests()[1].method).toBe("PUT");
  });
});

describe("step 3 — create", () => {
  it("creates with PUT, never POST, and carries our key", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts(active));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).resolves.toBe(CONTACT_ID);

    const create = requests()[2];
    // POST is `updateOrCreateContacts`: probed live, a POST whose Name collided
    // overwrote an existing contact's email and returned 200. PUT errors instead.
    expect(create.method).toBe("PUT");
    expect(create.path).toBe("/Contacts");
    expect(firstContactSent(2)).toEqual({
      Name: "John Smith",
      ContactNumber: `MMOPS-${CLIENT_ID}`,
      EmailAddress: "john@example.com",
      Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "07572382366" }],
    });
  });

  /**
   * `summarizeErrors=false` makes Xero return HTTP 200 for a REFUSED write. A
   * create that was rejected would read as success and the invoice would be
   * raised against nothing.
   */
  it("never appends summarizeErrors to any request", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts(active));

    await findOrCreateXeroContact({ ...customer, party: client });
    expect(requests().some((r) => r.path.toLowerCase().includes("summarizeerrors"))).toBe(false);
  });

  /** Xero rejects angle brackets and repeating spaces; lead names are free text
   *  from a public form, so a create must not 400 on punctuation. */
  it("sanitises the name Xero would reject", async () => {
    // No email, so there is no step-2 lookup: the create is the second call.
    mocks.xeroFetch.mockResolvedValueOnce(contacts()).mockResolvedValueOnce(contacts(active));

    await findOrCreateXeroContact({
      name: "  John   <b>Smith</b>  ",
      email: null,
      party: client,
    });
    expect(firstContactSent(1).Name).toBe("John bSmith/b");
  });

  it("refuses to create a contact with no usable name", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(contacts()).mockResolvedValueOnce(contacts());

    await expect(
      findOrCreateXeroContact({ name: "  <>  ", email: null, party: client }),
    ).rejects.toThrow(/empty name/);
  });

  /**
   * The live-write guard is real here, not stubbed. Peter, 2026-08-27: the live
   * Xero organisation is read-only until the cutover.
   */
  it("refuses to create anything in a non-demo organisation", async () => {
    mocks.readOrganisation.mockResolvedValue({ class: "COMPANY", name: "MarleyMoves Ltd" });
    mocks.xeroFetch.mockResolvedValueOnce(contacts()).mockResolvedValueOnce(contacts());

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /READ-ONLY until the cutover/,
    );
    expect(requests().every((r) => r.method === "GET")).toBe(true);
  });

  /** "I could not check" must not render as "safe to write": an org read that
   *  was refused for scope says so, instead of looking like a live org. */
  it("says SCOPE when the organisation read was rejected", async () => {
    mocks.readOrganisation.mockResolvedValue({ class: null, scopeDenied: true });
    mocks.xeroFetch.mockResolvedValueOnce(contacts()).mockResolvedValueOnce(contacts());

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /SCOPE problem/,
    );
  });

  /** Xero can report a per-element failure inside a 200 body. `res.ok` alone is
   *  not proof that anything was written. */
  it("does not treat a 200 carrying element errors as a create", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(
        json(200, {
          Contacts: [
            {
              HasValidationErrors: true,
              StatusAttributeString: "ERROR",
              ValidationErrors: [{ Message: "Email address must be valid." }],
            },
          ],
        }),
      );

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /the contact was not written/,
    );
  });

  it("refuses a create that returned no ContactID", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts({ ContactStatus: "ACTIVE", Name: "John Smith" }));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /returned no ContactID/,
    );
  });
});

describe("step 4 — the duplicate-name retry", () => {
  const validation = () =>
    validationError(
      "The contact name John Smith is already assigned to another contact. The contact name must be unique across all active contacts.",
    );

  it("retries once with a suffix derived from the stable id", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(validation())
      .mockResolvedValueOnce(contacts({ ...active, ContactID: OTHER_CONTACT_ID }));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).resolves.toBe(
      OTHER_CONTACT_ID,
    );
    expect(firstContactSent(2).Name).toBe("John Smith");
    // Deterministic, from the client id — never a counter, which would mint
    // (2), (3), (4) for one customer across crash-retries.
    expect(firstContactSent(3).Name).toBe("John Smith (a1b2c3d4)");
  });

  it("produces the SAME suffix on a later attempt, so a retry collides instead of duplicating", async () => {
    for (const _run of [1, 2]) {
      mocks.xeroFetch
        .mockResolvedValueOnce(contacts())
        .mockResolvedValueOnce(contacts())
        .mockResolvedValueOnce(validation())
        .mockResolvedValueOnce(contacts(active));
    }

    await findOrCreateXeroContact({ ...customer, party: client });
    const firstRun = firstContactSent(3).Name;
    await findOrCreateXeroContact({ ...customer, party: client });
    expect(firstContactSent(7).Name).toBe(firstRun);
  });

  /**
   * The retry is unconditional on the validation branch — never gated on
   * matching Xero's wording. `ValidationError` carries only a `Message` with no
   * code, so a message-matched retry stops happening the day Xero rewrites that
   * prose. Retrying after some other validation error costs one wasted call.
   */
  it("retries on ANY validation exception, not just a wording match", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(validationError("Some future wording nobody has seen"))
      .mockResolvedValueOnce(contacts(active));

    await expect(findOrCreateXeroContact({ ...customer, party: client })).resolves.toBe(CONTACT_ID);
    expect(mocks.xeroFetch).toHaveBeenCalledTimes(4);
  });

  it("gives up after exactly one retry, carrying what Xero objected to", async () => {
    mocks.xeroFetch
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(contacts())
      .mockResolvedValueOnce(validationError("first objection"))
      .mockResolvedValueOnce(validationError("second objection"));

    const err = await findOrCreateXeroContact({ ...customer, party: client }).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err.message).toContain("first objection");
    expect(err.message).toContain("second objection");
    expect(mocks.xeroFetch).toHaveBeenCalledTimes(4);
  });
});

describe("reading what Xero actually said", () => {
  /**
   * A malformed where clause is a fourth error type the original taxonomy for
   * this integration missed. It arrives as JSON with no `Elements`, so a parser
   * that only reads validation messages would report nothing useful.
   */
  it("surfaces a QueryParseException instead of an empty message", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(
      json(400, {
        ErrorNumber: 16,
        Type: "QueryParseException",
        Message: "Where clause invocation error: ...",
      }),
    );

    await expect(findOrCreateXeroContact({ ...customer, party: client })).rejects.toThrow(
      /QueryParseException[\s\S]*Where clause invocation error/,
    );
  });

  /**
   * Xero serves a 404 as HTML prose, not JSON. `res.json()` on it throws a
   * SyntaxError that says nothing about what failed — so the body is read as
   * text and quoted.
   */
  it("reports a 404 as a ledger error, not a JSON parse failure", async () => {
    mocks.xeroFetch.mockResolvedValueOnce(
      html(404, "The resource you're looking for cannot be found"),
    );

    const err = await findOrCreateXeroContact({ ...customer, party: client }).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err.message).toContain("cannot be found");
    expect(err.httpStatus).toBe(404);
  });
});
