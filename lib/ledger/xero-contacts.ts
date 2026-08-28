/**
 * Resolving a Marley customer to a Xero contact — SERVER ONLY.
 *
 * This is the single most dangerous read in the Xero adapter, because getting it
 * wrong does not fail: it succeeds against the wrong customer. Every invoice,
 * credit note and refund the adapter raises is addressed by the ContactID this
 * function returns, so a contact resolved by a *ranked* lookup rather than an
 * *exact* one bills a stranger and looks entirely normal doing it.
 *
 * ## The ladder
 *
 * ```
 * 1. our own key  -> GET /Contacts?where=ContactNumber=="MMOPS-{id}"   exactly one, or refuse
 * 2. email        -> GET /Contacts?where=EmailAddress=="…"             adopt on exactly one ACTIVE
 * 3. create       -> PUT /Contacts                                     never POST
 * 4. on 400 ValidationException, ONE retry with a deterministic suffix
 * ```
 *
 * Every step that can return more than one row asserts exactly one and refuses
 * on zero-or-many. This is `context/rules.md`'s "look a record up by its stable
 * id, never by search rank or first match", and under Xero it is not theoretical:
 * probing the Demo Company on 2026-08-28 found **two ACTIVE contacts sharing a
 * Name, an email AND a ContactNumber**, and `GET /Contacts/{ContactNumber}` —
 * the path form the design doc originally specified — returned HTTP 200 with one
 * of them, silently picking. The `where` form returned both. Xero performs the
 * ranking, so the `.[0]` bug looks like clean code.
 *
 * ## Why PUT and never POST for the create
 *
 * `PUT /Contacts` is `createContacts`; `POST /Contacts` is
 * `updateOrCreateContacts`. Probed live: a POST carrying only a Name that
 * collided with an existing contact returned **HTTP 200 and overwrote that
 * contact's email address**, keeping its ContactNumber. It did not create
 * anything. A create path built on POST edits a different customer's record in
 * the real books and reports success. PUT errors instead, which is what we want.
 *
 * POST appears exactly once below, supplying our own `ContactID` — a deliberate
 * update of a known row, which is the only shape that cannot retarget.
 *
 * ## Never `summarizeErrors`
 *
 * No write here appends that parameter, and none should. Xero's own words: "if
 * you are utilising the `summarizeErrors=false` querystring parameter you'll
 * **always** receive a HTTP 200 response even though some of the elements may
 * have failed". A refused contact create arriving as 200 would be read as
 * success, and the invoice would then be raised against nothing.
 */
import "server-only";

import { log } from "@/lib/log";
import type { LedgerParty } from "./party";
import { LedgerError } from "./types";
import { readOrganisation, xeroFetch } from "./xero-client";
import { assertWritable } from "./xero-guard";

/** Xero's `Contact`, in the shape this module actually reads. */
interface XeroContact {
  ContactID?: string;
  ContactNumber?: string;
  ContactStatus?: string;
  /**
   * "ID for the destination of a merged contact. Only returned when using
   * paging or when fetching a contact by ContactId or ContactNumber."
   *
   * Which is why every query below sends `page=1`: without paging Xero simply
   * omits the field, and a contact a human merged away in the Xero UI would read
   * as an ordinary healthy contact. Reachable today with no code change on our
   * side — someone tidying duplicates in Xero is all it takes.
   */
  MergedToContactID?: string;
  Name?: string;
  EmailAddress?: string;
  /* Xero's per-element write outcome — see `assertWritten`. */
  HasValidationErrors?: boolean;
  ValidationErrors?: { Message?: string }[];
  Warnings?: { Message?: string }[];
  StatusAttributeString?: string;
}

interface XeroContactsBody {
  Contacts?: XeroContact[];
  /* The error envelope, which shares the response shape. */
  ErrorNumber?: number;
  Type?: string;
  Message?: string;
  Elements?: XeroContact[];
}

/** One Xero call, with the body read exactly once. */
interface XeroReply {
  status: number;
  ok: boolean;
  /** Parsed body, or null when Xero did not answer in JSON. */
  json: XeroContactsBody | null;
  /** The raw body, only when it was not JSON. */
  text: string;
}

/** Xero's `Contact.ContactNumber` cap, from the spec (`maxLength: 50`). */
const CONTACT_NUMBER_MAX = 50;

/** Xero's `Contact.Name` cap, from the spec (`maxLength: 255`). */
const NAME_MAX = 255;

/**
 * Our stable key for a customer, written into Xero's `ContactNumber`.
 *
 * `ContactNumber` is API-settable, read-only in Xero's own contact screen, and
 * documented as "used to identify contacts in external systems" — so it is the
 * field Xero itself intends for this. `MMOPS-{uuid}` is 42 characters and
 * `MMOPSQ-{uuid}` is 43, both inside the 50-character cap.
 *
 * ## The prefixes MUST differ
 *
 * A `client`-keyed lookup must never match a `quote`-keyed contact. Consider the
 * order things happen in: a quote with no client row gets a contact keyed on the
 * quote id; later the customer gains a client row. If both kinds shared a prefix
 * and the ids ever coincided, the client lookup would adopt the quote-keyed
 * contact and the two identity spines would merge on the wrong side — silently,
 * on the money path. Distinct prefixes make that unrepresentable rather than
 * unlikely.
 *
 * ## Uniqueness, and the direction it fails in
 *
 * Measured live: `Name` must be unique across **active** contacts, while
 * `ContactNumber` must be unique across **all** contacts, archived included. So
 * archiving frees a name but never frees a key. That is the right way round for
 * us — our key can never be silently re-pointed at a different customer — but it
 * also means an archived contact holding our key is a permanent wedge, which is
 * why `assertUsable` refuses loudly rather than working around it.
 */
export function xeroContactNumber(party: LedgerParty): string {
  const value = ((): string => {
    switch (party.kind) {
      case "client":
        return `MMOPS-${party.id}`;
      case "quote":
        return `MMOPSQ-${party.id}`;
      default: {
        // Unreachable while `LedgerParty` is the closed union it is today. A new
        // kind of party needs its own prefix decided, not a shared one.
        const unhandled: never = party;
        throw new LedgerError(
          `Cannot build a Xero contact key for party ${JSON.stringify(unhandled)}.`,
        );
      }
    }
  })();
  if (value.length > CONTACT_NUMBER_MAX) {
    throw new LedgerError(
      `The Xero contact key "${value}" is ${value.length} characters and Xero caps ` +
        `ContactNumber at ${CONTACT_NUMBER_MAX}. Truncating it would make two customers ` +
        `share a key, so this refuses instead.`,
    );
  }
  assertWhereSafe(value, "the Xero contact key");
  return value;
}

/**
 * Xero's `where` clause has exactly one escape and it is not the intuitive one.
 *
 * Probed live: an unescaped `"` inside a value returns 400, a backslash escape
 * (`\"`) also returns 400, and only a doubled `""` parses. Rather than depend on
 * that — a quoting rule with no documentation behind it, on a query whose result
 * decides which customer gets billed — values carrying a quote or a backslash
 * are rejected outright. Our own keys are UUID-derived and can never contain
 * one; a customer email theoretically can, and that case is handled by skipping
 * the email step rather than by trusting the escape.
 */
function isWhereSafe(value: string): boolean {
  return !/["\\]/.test(value);
}

function assertWhereSafe(value: string, what: string): void {
  if (!isWhereSafe(value)) {
    throw new LedgerError(
      `Refusing to query Xero for ${what}: the value contains a quote or a backslash, ` +
        `which cannot be safely expressed in a where clause.`,
    );
  }
}

function whereEquals(field: string, value: string): string {
  assertWhereSafe(value, `${field}`);
  return `${field}=="${value}"`;
}

/** Issue one Xero call and read its body once, whatever shape it arrives in. */
async function call(path: string, init: RequestInit = {}): Promise<XeroReply> {
  const res = await xeroFetch(path, init);
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("json")) {
    // A Xero 404 answers in HTML with a prose sentence, not JSON — calling
    // `res.json()` on it throws a SyntaxError that surfaces nowhere useful. The
    // body is kept as text so the error message can quote what Xero said.
    return { status: res.status, ok: res.ok, json: null, text: (await res.text().catch(() => "")).trim() };
  }
  return {
    status: res.status,
    ok: res.ok,
    json: (await res.json().catch(() => null)) as XeroContactsBody | null,
    text: "",
  };
}

/** Every `ValidationErrors[].Message` Xero returned, across every element. */
function validationMessages(body: XeroContactsBody | null): string[] {
  return (body?.Elements ?? [])
    .flatMap((element) => element.ValidationErrors ?? [])
    .map((error) => (error.Message ?? "").trim())
    .filter(Boolean);
}

/**
 * Turn a failed reply into a `LedgerError` that says what Xero actually
 * objected to.
 *
 * Xero has four error `Type`s that matter here and they are structurally
 * distinguishable, so nothing below branches on wording. `ValidationException`
 * carries its detail in `Elements[].ValidationErrors[].Message`; the others
 * (`QueryParseException` among them — a malformed where clause, which the
 * original error taxonomy for this integration missed entirely) carry it in the
 * top-level `Message`.
 */
function failure(reply: XeroReply, operation: string): LedgerError {
  const details = validationMessages(reply.json);
  const said =
    details.length > 0
      ? details.join("; ")
      : (reply.json?.Message ?? "").trim() || reply.text.slice(0, 200) || `HTTP ${reply.status}`;
  const type = reply.json?.Type ? ` [${reply.json.Type}]` : "";
  return new LedgerError(
    `Xero refused to ${operation}${type}: ${said}`,
    reply.json?.ErrorNumber,
    reply.status,
  );
}

/** True when Xero rejected a write on the contents of the payload. */
function isValidationRejection(reply: XeroReply): boolean {
  // Structural, never the wording: `ValidationError` carries only a `Message`
  // with no code of its own, so the string is unusable as a branch — Xero can
  // and does rewrite that prose.
  return reply.status === 400 && reply.json?.Type === "ValidationException";
}

/**
 * Assert that a write actually wrote, per Xero's own success checklist:
 * a 200, no element-level validation errors, and an identifier for the object.
 *
 * The element-level checks are not defensive padding. Xero returns per-element
 * failures inside a 200 body under some parameters, so `res.ok` alone is not
 * proof that anything was created.
 */
function assertWritten(reply: XeroReply, operation: string): string {
  if (!reply.ok) throw failure(reply, operation);
  const contacts = reply.json?.Contacts ?? [];
  if (contacts.length !== 1) {
    throw new LedgerError(
      `Xero returned ${contacts.length} contacts when asked to ${operation}, expected 1. ` +
        `Refusing to guess which one the write produced.`,
    );
  }
  const contact = contacts[0];
  const errors = (contact.ValidationErrors ?? []).map((e) => e.Message ?? "").filter(Boolean);
  if (contact.HasValidationErrors === true || errors.length > 0 || contact.StatusAttributeString === "ERROR") {
    throw new LedgerError(
      `Xero reported HTTP ${reply.status} but the contact was not written (${operation}): ` +
        `${errors.join("; ") || contact.StatusAttributeString || "no detail given"}`,
      undefined,
      reply.status,
    );
  }
  if (!contact.ContactID) {
    throw new LedgerError(
      `Xero accepted the request to ${operation} but returned no ContactID, so there is ` +
        `nothing to invoice against.`,
      undefined,
      reply.status,
    );
  }
  const warnings = (contact.Warnings ?? []).map((w) => w.Message ?? "").filter(Boolean);
  // Xero asks integrations not to discard warnings. Logged rather than thrown:
  // the write succeeded, and a warning is information, not a refusal.
  if (warnings.length > 0) log.warn("ledger.xero.contact.warning", { operation, warnings });
  return contact.ContactID;
}

/**
 * Refuse unless this organisation may be written to.
 *
 * Creating or editing a contact is a write to somebody's books, so it passes the
 * same guard as an invoice. The live Xero organisation is read-only until the
 * cutover (Peter, 2026-08-27) and that is enforced here rather than remembered.
 */
async function assertContactsWritable(operation: string): Promise<void> {
  const org = await readOrganisation();
  if (org.scopeDenied) {
    // Without this branch the guard's message would talk about the cutover while
    // the real cause is a missing scope — the two are indistinguishable
    // downstream, because both arrive as an unreadable org class.
    throw new LedgerError(
      `Cannot ${operation}: reading the connected Xero organisation was rejected ` +
        `(HTTP 401/403), so the live-write guard cannot tell whether these are the real ` +
        `books. This is a SCOPE problem, not a safety one — re-authorise with ` +
        `accounting.settings.read.`,
    );
  }
  assertWritable(org, operation);
}

/** Contacts matching a where clause. Paged so `MergedToContactID` is returned. */
async function queryContacts(
  where: string,
  operation: string,
  options: { includeArchived?: boolean } = {},
): Promise<XeroContact[]> {
  const params = new URLSearchParams({ where, page: "1" });
  if (options.includeArchived) params.set("includeArchived", "true");
  const reply = await call(`/Contacts?${params.toString()}`);
  if (!reply.ok) throw failure(reply, operation);
  return reply.json?.Contacts ?? [];
}

/**
 * The ContactID of a contact we may safely invoice, or a loud refusal.
 *
 * Three ways a resolved contact is unusable, and none of them can be worked
 * around in code:
 *
 * - **Merged.** A human clicked Merge in Xero. The row still resolves and still
 *   looks healthy; writing to it is writing to a tombstone.
 * - **Archived.** Every invoice and credit note against an archived contact is
 *   rejected ("the contact must be un-archived before creating new invoices"),
 *   un-archiving is impossible through the API ("archived contacts cannot
 *   currently be edited via the API"), and the ContactNumber can never be
 *   reissued to a replacement because it stays reserved across archived
 *   contacts. All three were probed live. So this is a one-way wedge that makes
 *   one customer permanently un-invoiceable until a human acts in the Xero UI —
 *   which is exactly what the message says to do.
 * - **GDPRREQUEST.** The third value of Xero's three-value `ContactStatus` enum,
 *   which the API summary docs omit entirely. Its own branch rather than a
 *   silent failure of an `=== "ACTIVE"` test.
 */
function assertUsable(contact: XeroContact, foundBy: string): string {
  const id = contact.ContactID;
  if (!id) {
    throw new LedgerError(`Xero returned a contact with no ContactID when resolving ${foundBy}.`);
  }
  if (contact.MergedToContactID) {
    throw new LedgerError(
      `The Xero contact ${id} found by ${foundBy} has been MERGED into ` +
        `${contact.MergedToContactID} in Xero. Refusing to invoice a merged-away contact — ` +
        `a human must decide whether that destination is the same customer.`,
    );
  }
  const status = (contact.ContactStatus ?? "").toUpperCase();
  switch (status) {
    case "ACTIVE":
      return id;
    case "ARCHIVED":
      throw new LedgerError(
        `The Xero contact ${id} found by ${foundBy} is ARCHIVED. Xero rejects every ` +
          `invoice and credit note raised against an archived contact, and it cannot be ` +
          `un-archived through the API — a human must restore it in the Xero UI ` +
          `(Contacts → Archived → Restore). Creating a replacement will not work either: ` +
          `the contact number stays reserved across archived contacts.`,
      );
    case "GDPRREQUEST":
      throw new LedgerError(
        `The Xero contact ${id} found by ${foundBy} is under a GDPR erasure request. ` +
          `Refusing to raise new documents against it.`,
      );
    default:
      // Preserved verbatim rather than coerced, the same rule `xero-status.ts`
      // applies to invoice statuses: an unrecognised status is not evidence that
      // the contact is fine.
      throw new LedgerError(
        `The Xero contact ${id} found by ${foundBy} has an unrecognised ContactStatus ` +
          `"${contact.ContactStatus ?? ""}". Refusing to decide whether it is safe to ` +
          `invoice.`,
      );
  }
}

/**
 * Xero rejects a `Name` containing angle brackets, leading or trailing
 * whitespace, or repeating spaces, and caps it at 255 characters.
 *
 * Lead names are free text from a public web form, so this is not hypothetical.
 * Sanitising here means a create that fails does so for a reason worth
 * retrying — a genuine duplicate — rather than on a stray double space that the
 * suffix retry cannot fix either.
 */
function sanitiseName(raw: string, limit = NAME_MAX): string {
  const clean = raw.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
  if (!clean) {
    throw new LedgerError(
      `Refusing to create a Xero contact with an empty name (the supplied name was ` +
        `"${raw.slice(0, 40)}").`,
    );
  }
  return clean;
}

/**
 * A stable disambiguating suffix for a duplicate name — `John Smith (a1b2c3d4)`.
 *
 * Derived from the party id, so a crash-and-retry produces the *same* name and
 * collides with the contact the previous attempt created rather than minting a
 * new one. A counter would give one customer `(2)`, `(3)`, `(4)` across retries,
 * which is how a single person ends up with four contacts and four fragmented
 * ledgers.
 */
function disambiguate(name: string, party: LedgerParty): string {
  const suffix = ` (${party.id.replace(/[^a-z0-9]/gi, "").slice(0, 8)})`;
  return `${sanitiseName(name, NAME_MAX - suffix.length)}${suffix}`;
}

function createPayload(input: {
  name: string;
  email?: string | null;
  phone?: string | null;
  contactNumber: string;
}): string {
  const email = (input.email ?? "").trim();
  const phone = (input.phone ?? "").trim();
  return JSON.stringify({
    Contacts: [
      {
        Name: input.name,
        ContactNumber: input.contactNumber,
        ...(email ? { EmailAddress: email } : {}),
        // `PhoneType: "DEFAULT"` is the spec's enum value for a contact's main
        // number; Xero caps `PhoneNumber` at 50 characters.
        ...(phone ? { Phones: [{ PhoneType: "DEFAULT", PhoneNumber: phone.slice(0, 50) }] } : {}),
      },
    ],
  });
}

/**
 * Find the Xero contact for this customer, creating one if none exists.
 *
 * Returns the ContactID. Every failure mode is a throw rather than a fallback:
 * there is no weaker-but-acceptable answer to "which customer is this", and a
 * plausible guess here is an invoice sent to the wrong person.
 */
export async function findOrCreateXeroContact(input: {
  name: string;
  email?: string | null;
  phone?: string | null;
  party: LedgerParty;
}): Promise<string> {
  const contactNumber = xeroContactNumber(input.party);

  // 1. Our own key. `includeArchived` deliberately ON: an archived contact
  //    holding this key is a permanent wedge, and seeing it here turns a
  //    cryptic "contact number is already assigned" 400 three calls later into
  //    a message naming the fix.
  const byNumber = await queryContacts(
    whereEquals("ContactNumber", contactNumber),
    `look up the contact keyed ${contactNumber}`,
    { includeArchived: true },
  );
  if (byNumber.length > 1) {
    throw new LedgerError(
      `Xero holds ${byNumber.length} contacts with the key ${contactNumber} ` +
        `(${byNumber.map((c) => c.ContactID ?? "?").join(", ")}). That key is ours and is ` +
        `supposed to be unique, so refusing to choose one — a human must merge or ` +
        `re-key them in Xero.`,
    );
  }
  if (byNumber.length === 1) return assertUsable(byNumber[0], `key ${contactNumber}`);

  // 2. Email. Adoption only, and only on exactly one match. The default query
  //    excludes archived contacts, which is what we want here: an archived
  //    contact is not a contact we may adopt.
  const email = (input.email ?? "").trim();
  if (email && isWhereSafe(email)) {
    const byEmail = await queryContacts(
      whereEquals("EmailAddress", email),
      "look up a contact by email address",
    );
    if (byEmail.length > 1) {
      throw new LedgerError(
        `Xero holds ${byEmail.length} active contacts with this customer's email address ` +
          `(${byEmail.map((c) => c.ContactID ?? "?").join(", ")}). Refusing to adopt one and ` +
          `refusing to create another — a human must decide which is the customer.`,
      );
    }
    if (byEmail.length === 1) {
      const adopted = assertUsable(byEmail[0], "email address");
      await stampContactNumber(adopted, contactNumber, byEmail[0]);
      return adopted;
    }
  } else if (email) {
    // Not an error: the customer is simply unfindable by email, so we fall
    // through to a create. The worst case is a second contact for one person —
    // fragmentation, visible in Xero and fixable by a human — which is the same
    // trade `partyForQuote` makes, and never a mis-billing.
    log.warn("ledger.xero.contact.email_unqueryable", { contactNumber });
  }

  // 3. Create.
  return await createContact(input, contactNumber);
}

/**
 * Write our key onto a contact we adopted by email — unless it already carries
 * one from another integration.
 *
 * Xero's own best-practice guidance: "please check the existing contacts in Xero
 * to make sure that they don't already have a contact number assigned from
 * another app integration." Blind-stamping would silently break whatever system
 * put that value there, and `ContactNumber` holds exactly one value.
 *
 * A failed stamp is logged, not thrown. The contact we are returning is correct
 * either way — the stamp is only an optimisation that lets the next call resolve
 * at step 1 instead of step 2 — so turning a bookkeeping nicety into a failed
 * invoice on a money path would be the wrong trade. It is logged because a
 * branch that quietly stops working is the shape this codebase keeps getting
 * bitten by.
 */
async function stampContactNumber(
  contactId: string,
  contactNumber: string,
  existing: XeroContact,
): Promise<void> {
  if ((existing.ContactNumber ?? "").trim()) {
    log.info("ledger.xero.contact.number_already_set", { contactId, ours: contactNumber });
    return;
  }
  try {
    await assertContactsWritable(`stamp the contact key ${contactNumber} onto contact ${contactId}`);
    // The one POST in this module, and it is safe precisely because it supplies
    // the ContactID: Xero updates that row rather than matching on a name and
    // retargeting somebody else's contact.
    const reply = await call("/Contacts", {
      method: "POST",
      body: JSON.stringify({ Contacts: [{ ContactID: contactId, ContactNumber: contactNumber }] }),
    });
    assertWritten(reply, `stamp the contact key onto contact ${contactId}`);
    log.info("ledger.xero.contact.number_stamped", { contactId, contactNumber });
  } catch (err) {
    log.warn("ledger.xero.contact.stamp_failed", {
      contactId,
      contactNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Create the contact, with exactly one retry under a disambiguated name.
 *
 * The retry is unconditional on the validation branch rather than gated on
 * matching Xero's duplicate-name wording. `ValidationError` carries only a
 * `Message` — there is no per-error code — so a message-matched retry stops
 * happening the day Xero rewrites that prose, silently and on the money path.
 * Retrying after some *other* validation error (a malformed email, say) simply
 * fails again identically and costs one call, which is the cheaper mistake.
 */
async function createContact(
  input: { name: string; email?: string | null; phone?: string | null; party: LedgerParty },
  contactNumber: string,
): Promise<string> {
  await assertContactsWritable(`create the Xero contact ${contactNumber}`);

  const first = await call("/Contacts", {
    method: "PUT",
    body: createPayload({
      name: sanitiseName(input.name),
      email: input.email,
      phone: input.phone,
      contactNumber,
    }),
  });
  if (!isValidationRejection(first)) {
    const contactId = assertWritten(first, `create the contact ${contactNumber}`);
    log.info("ledger.xero.contact.created", { contactId, contactNumber });
    return contactId;
  }

  const retryName = disambiguate(input.name, input.party);
  const second = await call("/Contacts", {
    method: "PUT",
    body: createPayload({
      name: retryName,
      email: input.email,
      phone: input.phone,
      contactNumber,
    }),
  });
  if (isValidationRejection(second)) {
    // Both attempts refused. Carry every message Xero gave, from both attempts,
    // so the ops alert says what it actually objected to rather than leaving an
    // operator to guess that it was a duplicate name.
    const said = [...validationMessages(first.json), ...validationMessages(second.json)];
    throw new LedgerError(
      `Xero refused to create the contact ${contactNumber}, twice — once as supplied and ` +
        `once as "${retryName}": ${said.join("; ") || "no detail given"}`,
      second.json?.ErrorNumber,
      second.status,
    );
  }
  const contactId = assertWritten(second, `create the contact ${contactNumber}`);
  log.info("ledger.xero.contact.created_disambiguated", { contactId, contactNumber });
  return contactId;
}
