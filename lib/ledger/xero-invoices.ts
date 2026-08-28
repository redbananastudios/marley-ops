/**
 * Xero invoice + payment operations — SERVER ONLY.
 *
 * Nine of the thirteen `LedgerAdapter` operations live here; the credit-note
 * three live in `xero-credit-notes.ts` and the contact one in the adapter that
 * assembles them. Everything below was probed against the live Xero Demo
 * Company on 2026-08-28 and then independently re-probed by a skeptic — where
 * the two disagreed the re-probe won, and the four places that mattered are
 * called out at the code they shaped.
 *
 * ## The shape of the risk
 *
 * Xero's own OpenAPI spec has now been wrong about this API **five** separate
 * times in this project (a missing `AUTHORISED` status, a contact path that
 * 404s, a credit-note type that does not exist, a PDF path that does not
 * exist, and a documented-but-untrue claim that list rows omit `LineItems`).
 * So nothing here is written from the spec alone: every request shape below was
 * exercised against a real organisation, and the ones that could not be are
 * marked rather than smoothed over.
 *
 * ## Three properties this file holds
 *
 * 1. **Ambiguity yields nothing.** Xero does NOT enforce a unique `Reference` —
 *    the recon created three invoices sharing one and read them all back — so
 *    `findInvoiceByReference` asserts exactly one live match and raises on two.
 *    `[0]` on a multi-row read is the failure `context/rules.md` prohibits and
 *    marley-ops `875eec3` already paid for once.
 * 2. **Every write is gated by `assertWritable`.** The live Xero organisation is
 *    read-only until the cutover (Peter, 2026-08-27). Reads are never gated.
 * 3. **Nothing org-specific is hardcoded.** Account codes, branding themes and
 *    the org short code all come from `xero-config.ts` and fail closed naming
 *    their env var. They are org-specific AND the Demo Company resets every 28
 *    days, so a value that looks right today is wrong on a schedule.
 */
import "server-only";

import { createHash } from "node:crypto";

import { addDaysIso, ukTodayDate } from "@/lib/finance/invoices";
import { log } from "@/lib/log";
import {
  xeroBrandingThemeId,
  xeroOrgShortCode,
  xeroPaymentAccountId,
  xeroTaxType,
} from "./xero-config";
import { readOrganisation, xeroFetch } from "./xero-client";
import { assertWritable } from "./xero-guard";
import { isKnownXeroStatus, ledgerStatusFromXero } from "./xero-status";
import {
  LedgerError,
  type CreateInvoiceInput,
  type LedgerInvoiceList,
  type LedgerInvoiceListItem,
  type LedgerInvoiceRef,
  type LedgerInvoiceStatus,
  type RecordPaymentInput,
} from "./types";

/* ============================================================ shared plumbing
 *
 * The HTTP plumbing below is exported because `xero-credit-notes.ts` needs the
 * identical error taxonomy, write guard and idempotency key, and a third module
 * for six small functions would put the write-safety assertions further from
 * the writes they protect. Invoices is the larger module, so it is the home.
 */

/** Xero's error envelope, in the two JSON shapes it actually arrives in. */
interface XeroErrorBody {
  ErrorNumber?: number;
  Type?: string;
  Message?: string;
  Elements?: { ValidationErrors?: { Message?: string }[] }[];
}

/** The per-element write receipt Xero returns inside a 200. */
export interface XeroWriteElement {
  HasValidationErrors?: boolean;
  ValidationErrors?: { Message?: string }[];
  StatusAttributeString?: string;
  Warnings?: { Message?: string }[];
}

/**
 * Turn a failed response into a `LedgerError` that says something useful.
 *
 * Branch on the STATUS before parsing, because Xero's error bodies are not all
 * JSON: a 404 is 47 bytes of `text/html` reading "The resource you're looking
 * for cannot be found", and `res.json()` throws a `SyntaxError` on it that
 * would reach the caller instead of the real cause.
 *
 * Three JSON error types are known, and the third is why this reads `Type`
 * rather than assuming: `ValidationException` (a rejected write),
 * `QueryParseException` (a malformed `where` clause — the first recon pass
 * reported this one as an HTML body, and the re-probe found it is JSON with
 * `ErrorNumber 16`), and the bare `{Message}` shape. Anything else keeps its
 * raw text, truncated.
 *
 * 429 carries `Retry-After`; surfacing it is the difference between a cron that
 * backs off and one that reads as a provider outage.
 */
export async function xeroFail(res: Response, what: string): Promise<never> {
  const text = await res.text().catch(() => "");
  let detail = text.trim().slice(0, 300) || `HTTP ${res.status}`;
  let code: number | undefined;

  try {
    const body = JSON.parse(text) as XeroErrorBody;
    if (body && typeof body === "object") {
      code = body.ErrorNumber;
      const validation = body.Elements?.flatMap((el) =>
        (el.ValidationErrors ?? []).map((v) => v.Message ?? ""),
      ).filter(Boolean);
      // Every validation message, not just the first: `ValidationError` carries
      // no code (its only property is `Message`), so the prose IS the whole
      // explanation an operator gets, and dropping four fifths of it to show
      // `[0]` is how an ops alert becomes unactionable.
      detail = validation?.length ? validation.join("; ") : (body.Message ?? detail);
      if (body.Type) detail = `${body.Type}: ${detail}`;
    }
  } catch {
    /* html or plain text — the raw slice above is the best available. */
  }

  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    detail = `rate limited${retry ? ` — retry after ${retry}s` : ""} (${detail})`;
  }
  if (res.status === 404 && !text.trim()) {
    // The PDF 404 has a genuinely empty body, so there is nothing to quote.
    detail = "not found (empty response body)";
  }

  throw new LedgerError(`Xero ${what} failed: ${detail}`, code, res.status);
}

/** Read a JSON response, or fail with the status rather than a `SyntaxError`. */
export async function xeroJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) await xeroFail(res, what);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LedgerError(
      `Xero ${what} returned a 200 that is not JSON (${text.trim().slice(0, 200) || "empty body"})`,
      undefined,
      res.status,
    );
  }
}

/**
 * Confirm a write was actually accepted.
 *
 * Xero's own success checklist asks for more than `res.ok`, and it is right to:
 * with `summarizeErrors=false` a REJECTED element arrives under **HTTP 200**
 * carrying its own `ValidationErrors`. We never send that parameter — but the
 * cost of checking is one branch and the cost of not checking is a refused
 * refund read as a success, which is the exact shape the repo's "'I could not
 * check' must never render as 'nothing to report'" rule exists to stop.
 *
 * `Warnings` are logged rather than discarded — Xero explicitly asks
 * integrations not to swallow them.
 */
export function assertWriteAccepted(
  element: XeroWriteElement | undefined,
  what: string,
  id: string | null | undefined,
): void {
  if (!element) {
    throw new LedgerError(`Xero ${what} returned no document — refusing to report it as done.`);
  }
  const errors = (element.ValidationErrors ?? []).map((v) => v.Message ?? "").filter(Boolean);
  if (element.HasValidationErrors === true || errors.length > 0 || element.StatusAttributeString === "ERROR") {
    throw new LedgerError(
      `Xero ${what} was rejected: ${errors.join("; ") || "validation failed with no message"}`,
    );
  }
  if (!id) {
    throw new LedgerError(`Xero ${what} returned no identifier — refusing to report it as done.`);
  }
  const warnings = (element.Warnings ?? []).map((w) => w.Message ?? "").filter(Boolean);
  if (warnings.length) log.warn("ledger.xero.write_warning", { what, warnings });
}

/**
 * Refuse the write unless the connected organisation is a Demo Company.
 *
 * The scope case is separated deliberately. `readOrganisation` returns a null
 * class both when the org is unreadable and when the token lacks
 * `accounting.settings.read`, and the guard treats both as LIVE — correct, but
 * the resulting message talks about the cutover while the real cause is a
 * missing scope. Naming it here saves an operator the wrong investigation.
 */
export async function assertXeroWritable(operation: string): Promise<void> {
  const org = await readOrganisation();
  if (org.scopeDenied) {
    throw new LedgerError(
      `Cannot ${operation} in Xero: reading the organisation was refused (401/403), so whether ` +
        `these are the live books could not be determined. Suspect a missing ` +
        `accounting.settings.read scope — re-authorise with scripts/xero-authorise.mjs.`,
    );
  }
  assertWritable(org, operation);
}

/**
 * An idempotency key for one create attempt.
 *
 * **Xero's window is 6 minutes, not hours.** It is a network-retry device, not
 * the never-create-twice spine: it does not survive a container restart, a
 * crash between the Xero create and our DB write-back, or a cron re-run. The
 * real idempotency mechanism is adopt-by-reference
 * ({@link findInvoiceByReference} before {@link createInvoice}), exactly as it
 * is under Zoho. A retry after the window creates a DUPLICATE.
 *
 * Xero recommends four concatenated UUIDs, but the header is capped at 128
 * characters and four hyphenated UUIDs is 144 — it would 400. Three
 * hyphen-stripped UUIDs is 96 characters and 288 bits, which is past the point
 * where more entropy buys anything.
 */
export function idempotencyKey(identity: string): string {
  /**
   * DERIVED from what the write is, not random.
   *
   * The first draft minted three fresh UUIDs per call, which reads as careful
   * and dedupes nothing: Xero's 6-minute window only collapses a retry that
   * carries the SAME key, and every attempt was generating a different one — so
   * the header was decoration. Hashing the operation's natural identity means a
   * retry of the same logical write genuinely replays instead of creating a
   * second document.
   *
   * SHA-256 hex is 64 characters, inside Xero's 128-character cap.
   */
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * JSON write headers, including the idempotency key.
 *
 * `identity` must name the operation AND the thing it acts on — e.g.
 * `creditnote-create|MMR001-CN-abc` — so two different writes never collide and
 * the same write always agrees with itself.
 */
export function writeInit(body: unknown, identity: string): RequestInit {
  return {
    method: "PUT",
    headers: { "Idempotency-Key": idempotencyKey(identity) },
    body: JSON.stringify(body),
  };
}

/**
 * Guard a value going into a `where` clause.
 *
 * Xero's escape for a literal double quote inside a quoted value is DOUBLING
 * it; the intuitive backslash escape 400s (both probed live). We reject rather
 * than escape: our references are `MMR001-DEP`-shaped and a quote character in
 * one means something upstream is already wrong, so accepting it would let a
 * malformed reference decide which invoice we adopt.
 */
export function assertSafeReference(reference: string): string {
  const value = reference.trim();
  if (!value) throw new LedgerError("Refusing to look up an empty ledger reference.");
  // A double quote, a backslash (char 92) or any control character. Written by
  // code point rather than as a regex class so the escaping of the escape
  // characters cannot itself be the bug.
  if ([...value].some((ch) => ch === '"' || ch.charCodeAt(0) === 92 || ch.charCodeAt(0) < 32)) {
    throw new LedgerError(
      `Refusing to look up reference ${JSON.stringify(reference)} — it contains a quote, ` +
        `backslash or control character, which cannot be safely put in a Xero where clause.`,
    );
  }
  return value;
}

/**
 * `yyyy-mm-dd` from a Xero row.
 *
 * Every Xero date is serialised twice: `Date` as `/Date(1780185600000+0000)/`
 * and `DateString` as `2026-05-31T00:00:00`. Our contract is plain
 * `yyyy-mm-dd`, and `ledgerStatusFromXero` COMPARES the due date with `<`
 * against today — so feeding it the `/Date(...)/` form silently makes every
 * invoice not-overdue. Prefer the string form; fall back to parsing the
 * millisecond form, which some fields (`FullyPaidOnDate`) have no string twin
 * for.
 */
export function xeroDay(dateString?: string | null, dateMs?: string | null): string {
  if (dateString && dateString.length >= 10) return dateString.slice(0, 10);
  const ms = /\/Date\((-?\d+)/.exec(dateMs ?? "");
  if (!ms) return "";
  return new Date(Number(ms[1])).toISOString().slice(0, 10);
}

/**
 * The nominal account an income line posts to, by the caller's `itemName`.
 *
 * **This belongs in `xero-config.ts` and should move there.** It is org-specific
 * in exactly the way that file exists to hold, and it is here only because that
 * file shipped in parallel without a getter for it — importing a name that does
 * not exist would have made both this module and its tests unrunnable, which is
 * a worse trade than one clearly-labelled temporary home. The BEHAVIOUR is the
 * file's rule, unchanged: unset fails closed naming the variable, never a guess.
 *
 * Why this exists at all: Zoho Invoice has no chart of accounts, so `itemName`
 * was the only income-separation handle available and it rode on the line's
 * name. Xero has a real one, and the `LineItem` schema has no `Name` field to
 * put the old handle on — so "Storage" resolves to its own income account and
 * storage income never mixes with Removals Income (standing policy 2026-07-22).
 * An unrecognised `itemName` takes the default account rather than inventing a
 * variable name from user data.
 */
export function xeroIncomeAccountCode(
  itemName?: string | null,
  env: Record<string, string | undefined> = process.env,
): string {
  const storage = (itemName ?? "").trim().toLowerCase() === "storage";
  const name = storage ? "XERO_ACCOUNT_STORAGE_INCOME" : "XERO_ACCOUNT_INCOME";
  const value = (env[name] ?? "").trim();
  if (value) {
    /**
     * The inverse of the mistake `xeroPaymentAccountId` guards.
     *
     * The three `XERO_ACCOUNT_*` payment rails all demand a GUID AccountID and
     * explain, when given a Code, that Code is user-editable. Sitting beside
     * them in the same app.env, this one wants the opposite — Xero's invoice
     * LINE requires `AccountCode`. An operator who makes all four consistent
     * gets a raw Xero ValidationException on every invoice raise, on the money
     * path, with nothing naming the variable that is wrong.
     */
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new LedgerError(
        `${name} looks like a Xero AccountID (a GUID), but an invoice line needs the ` +
          `account CODE — the short number the Chart of Accounts screen shows, e.g. "200". ` +
          `This is the opposite of XERO_ACCOUNT_BANKTRANSFER and its siblings, which do ` +
          `want the AccountID; the two Xero APIs disagree, so the variables do too.`,
      );
    }
    return value;
  }
  // Storage falls back to the general income account rather than failing: one
  // configured account raises correct invoices that an accountant can reclassify,
  // whereas refusing would stop storage billing outright. The general account has
  // no such fallback — there is nothing left to fall back to.
  if (storage) {
    const general = (env.XERO_ACCOUNT_INCOME ?? "").trim();
    if (general) {
      log.warn("ledger.xero.storage_income_account_unset", { fallback: "XERO_ACCOUNT_INCOME" });
      return general;
    }
  }
  throw new LedgerError(
    `No Xero income account is configured — set ${name} to the account CODE (e.g. "200") ` +
      `that this income posts to. Xero requires an account code on every line of an ` +
      `approved sales invoice, and refusing to guess is the point: the wrong code books ` +
      `real revenue against the wrong nominal.`,
  );
}

/** Round to pennies the same way every money comparison in this repo does. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function num(value: unknown): number {
  return Number(value ?? 0);
}

/* ================================================================== invoices */

interface XeroLineItem {
  Description?: string;
  Quantity?: number;
  UnitAmount?: number;
  AccountCode?: string;
  TaxType?: string;
  TaxAmount?: number;
}

interface XeroInvoiceRow extends XeroWriteElement {
  InvoiceID?: string;
  InvoiceNumber?: string;
  Reference?: string;
  Type?: string;
  Status?: string;
  Total?: number;
  TotalTax?: number;
  AmountDue?: number;
  AmountPaid?: number;
  Date?: string;
  DateString?: string;
  DueDate?: string;
  DueDateString?: string;
  Contact?: { Name?: string; ContactID?: string };
  LineItems?: XeroLineItem[];
}

interface XeroInvoicesResponse {
  Invoices?: XeroInvoiceRow[];
  pagination?: { page?: number; pageSize?: number; pageCount?: number; itemCount?: number };
}

/**
 * A row that provably came from `GET /Invoices/{id}`.
 *
 * The brand is compile-time only and exists for exactly one caller —
 * {@link invoiceCarriesVat}. See the comment there; this is the type half of
 * a live-money defect that reads as clean.
 */
declare const SINGLE_INVOICE_READ: unique symbol;
type SingleInvoiceRead = XeroInvoiceRow & { readonly [SINGLE_INVOICE_READ]: true };

/** Terminal statuses: the document no longer represents money owed. */
const DEAD_STATUSES = new Set(["VOIDED", "DELETED"]);

/** Map a Xero status, logging anything this build does not recognise. */
function statusOf(row: XeroInvoiceRow, today: string) {
  const raw = row.Status ?? "";
  if (!isKnownXeroStatus(raw)) {
    // The verbatim pass-through in `ledgerStatusFromXero` is the safe
    // rendering, but nobody finds out about it unless something says so.
    log.warn("ledger.xero.unknown_invoice_status", { status: raw, invoiceId: row.InvoiceID });
  }
  return ledgerStatusFromXero(
    raw,
    {
      amountPaid: num(row.AmountPaid),
      amountDue: num(row.AmountDue),
      dueDate: xeroDay(row.DueDateString, row.DueDate) || null,
    },
    today,
  );
}

/**
 * The customer-facing hosted invoice page.
 *
 * Not on the invoice payload — Xero puts it behind its own call, and the
 * invoice's own `Url` field is a different thing (an outbound "Go to [appName]"
 * link back to us, null on every row read). Best-effort by design: the
 * document already exists by the time this runs, and every consumer of
 * `invoiceUrl` renders it conditionally (`m.invoiceUrl ? button : ""`), so a
 * missing link costs an email button. Throwing here would throw away a
 * successful create.
 */
async function onlineInvoiceUrl(invoiceId: string): Promise<string | null> {
  try {
    const res = await xeroFetch(`/Invoices/${encodeURIComponent(invoiceId)}/OnlineInvoice`);
    if (!res.ok) {
      // Documented: a DRAFT invoice has no online URL. We raise AUTHORISED, so
      // this is unexpected rather than routine — say so, do not fail the write.
      log.warn("ledger.xero.online_invoice_url_failed", { invoiceId, status: res.status });
      return null;
    }
    const json = (await res.json()) as { OnlineInvoices?: { OnlineInvoiceUrl?: string }[] };
    return json.OnlineInvoices?.[0]?.OnlineInvoiceUrl?.trim() || null;
  } catch (err) {
    log.warn("ledger.xero.online_invoice_url_failed", {
      invoiceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Adopt an existing invoice by OUR reference — the idempotency half of
 * never-create-twice, covering a crash between the Xero create and the DB
 * write-back.
 *
 * **`where`, never `searchTerm`.** `searchTerm` is a case-insensitive substring
 * search across `InvoiceNumber` and `Reference`, so `MMR001` would match
 * `MMR0011-DEP`. Our references are exactly the colliding shape — `-DEP`,
 * `-COM` and `-BAL` give three invoices per quote.
 *
 * **Two matches is an error, not a choice.** Xero does not enforce a unique
 * `Reference`: the recon created three invoices sharing one and read all three
 * back through this same query, so the duplicate state is reachable by a plain
 * retry rather than being theoretical. Taking `[0]` here would adopt an
 * arbitrary one of them and bill against it.
 *
 * `Type=="ACCREC"` narrows to sales invoices so a supplier bill that happens to
 * carry the same reference can never surface. Both fields are optimised for
 * `where`.
 *
 * A miss is HTTP 200 with an empty array, never a 404.
 */
function whereClause(reference: string): string {
  return `Type=="ACCREC" AND Reference=="${reference}"`;
}

export async function findInvoiceByReference(
  reference: string,
): Promise<(LedgerInvoiceRef & { total?: number }) | null> {
  const value = assertSafeReference(reference);
  // Exactly ONE encoding pass. Encoding twice turns `==` into `%253D%253D` and
  // a literal `%` reaches Xero's filter parser, which fails the request. And
  // `URLSearchParams` is deliberately not used: it encodes a space as `+`,
  // which is form-encoding rather than URL-encoding, and this clause contains
  // spaces around its `AND`.
  const res = await xeroFetch(`/Invoices?where=${encodeURIComponent(whereClause(value))}`);
  const json = await xeroJson<XeroInvoicesResponse>(res, `invoice lookup for ${value}`);

  // Voided and deleted documents are still returned by a reference query, and
  // adopting one would mean raising nothing and then failing to take payment
  // against it. Same skip `lib/zoho.ts` makes.
  const live = (json.Invoices ?? []).filter((inv) => !DEAD_STATUSES.has(inv.Status ?? ""));
  if (live.length === 0) return null;
  if (live.length > 1) {
    throw new LedgerError(
      `Xero holds ${live.length} live invoices with reference ${value} ` +
        `(${live.map((i) => i.InvoiceNumber ?? i.InvoiceID).join(", ")}). Refusing to guess which ` +
        `one this quote's money belongs to — a human must void the duplicates in Xero.`,
    );
  }

  const inv = live[0];
  if (!inv.InvoiceID) {
    throw new LedgerError(`Xero returned an invoice for ${value} with no InvoiceID.`);
  }
  return {
    invoiceId: inv.InvoiceID,
    invoiceNumber: inv.InvoiceNumber ?? "",
    invoiceUrl: await onlineInvoiceUrl(inv.InvoiceID),
    // Adopters use the total to verify an orphan actually bills what we
    // computed, and never adopt a mismatch.
    ...(inv.Total != null ? { total: num(inv.Total) } : {}),
  };
}

/**
 * Raise an invoice, approved and payable in one call.
 *
 * Four things that are easy to get wrong and cost real money:
 *
 * - **`PUT`, not `POST`.** `PUT` creates; `POST` is create-or-update and will
 *   silently edit an existing document.
 * - **`LineAmountTypes: "Inclusive"`, always and explicitly.** Our `amount` is
 *   the customer-facing VAT-INCLUSIVE total. Xero's documented default is
 *   EXCLUSIVE, so omitting this adds 20% on top of a price the customer has
 *   already been quoted.
 * - **`Status: "AUTHORISED"` in the create body.** There is no separate approve
 *   step (unlike Zoho's `POST /invoices/{id}/status/sent`); omitting it leaves a
 *   DRAFT, which has no journals, cannot take a payment, and has no online URL.
 * - **`Contact` carries `ContactID` and nothing else.** Xero, verbatim: "If you
 *   send other contact details, they update the contact record itself, and any
 *   ContactPersons not included in the request are deleted." Sending a name
 *   alongside would quietly mutate a customer record.
 *
 * `itemName` becomes an `AccountCode`, not a line name — the `LineItem` schema
 * has no `Name` field at all. Zoho Invoice has no chart of accounts, so a line
 * name was the only income-separation handle available there; Xero has a real
 * one, so "Storage" resolves to the storage income account and storage income
 * stays out of Removals Income (standing policy 2026-07-22).
 *
 * The VAT `TaxType` comes from config rather than being derived here or left to
 * the account's default — see the line item for why.
 */
export async function createInvoice(input: CreateInvoiceInput): Promise<LedgerInvoiceRef> {
  const reference = assertSafeReference(input.reference);
  await assertXeroWritable(`create invoice ${reference}`);

  // `disableOnlinePayments` cannot be honoured per invoice in Xero — online
  // payment services attach to a BRANDING THEME, not to a document. So "this
  // invoice must not be payable by card" becomes "raise it under a theme with
  // no payment service attached", and the policy — including whether a
  // suppressed theme is required at all, which depends on whether card is
  // enabled in Xero in the first place — lives in config. Peter's 2026-07-09
  // decision that card fees are too high at balance values is what this
  // protects, so config must fail closed rather than fall back to the default
  // theme when suppression is asked for and no suppressed theme exists.
  const brandingThemeId = xeroBrandingThemeId({
    disableOnlinePayments: input.disableOnlinePayments === true,
  });

  const body = {
    Invoices: [
      {
        Type: "ACCREC",
        Contact: { ContactID: input.customerId },
        LineItems: [
          {
            // Xero invoices have no notes field of any kind — the nearest
            // customer-visible free text is the line description, so the notes
            // ride there rather than being silently dropped. Every caller's
            // notes are written to be read by the customer ("Deposit to secure
            // your move date…"), which is exactly what this line renders as.
            Description: input.notes
              ? `${input.description}\n\n${input.notes}`
              : input.description,
            Quantity: 1,
            UnitAmount: round2(input.amount),
            AccountCode: xeroIncomeAccountCode(input.itemName),
            // Stated explicitly rather than inherited from the account's own
            // default rate. Every invoice this business raises is VAT-inclusive
            // at the UK standard rate — `lib/finance/invoices.ts` builds the
            // whole /finance VAT view on that basis — so the document should
            // say so rather than depend on a chart-of-accounts setting a
            // bookkeeper can edit. Config refuses the one wrong value that
            // looks right: `OUTPUT` is the legacy 17.5% rate and is DELETED;
            // the live 20% one is `OUTPUT2`.
            TaxType: xeroTaxType(true),
          },
        ],
        LineAmountTypes: "Inclusive",
        Reference: reference,
        Status: "AUTHORISED",
        Date: ukTodayDate(),
        ...(brandingThemeId ? { BrandingThemeID: brandingThemeId } : {}),
      },
    ],
  };

  const res = await xeroFetch("/Invoices", writeInit(body, `invoice-create|${reference}`));
  const json = await xeroJson<XeroInvoicesResponse>(res, `invoice create for ${input.reference}`);
  const created = json.Invoices?.[0];
  assertWriteAccepted(created, `invoice create for ${input.reference}`, created?.InvoiceID);

  /**
   * We asked for AUTHORISED; check we got it.
   *
   * An org with the invoice-approval workflow enabled, or an app user on the
   * "Standard — can't approve" role, returns the document at DRAFT or SUBMITTED
   * instead. Without this the raise reports success, the id is persisted and the
   * customer is emailed a deposit request for an invoice that carries no
   * journals — then `recordInvoicePayment` fails against it later with "Invoice
   * not of valid status for modification", long after the money arrived.
   *
   * `voidInvoice` below already asserts its own resulting status; this is the
   * mirror it was missing. Deliberately not inferred from `invoiceUrl` being
   * null, which is best-effort by design and so cannot tell this apart from an
   * ordinary transient miss.
   */
  if (created!.Status !== "AUTHORISED") {
    throw new LedgerError(
      `Xero accepted the invoice for ${input.reference} but returned it as ` +
        `${created!.Status ?? "an unknown status"}, not AUTHORISED — it is not owed by ` +
        `anyone and carries no journals. This usually means the organisation has an ` +
        `invoice-approval workflow enabled, or the connected user cannot approve. ` +
        `Refusing to report a raise that did not happen.`,
    );
  }

  const invoiceId = created!.InvoiceID!;
  return {
    invoiceId,
    invoiceNumber: created!.InvoiceNumber ?? "",
    invoiceUrl: await onlineInvoiceUrl(invoiceId),
  };
}

/** How many rows one page asks for. Xero's maximum is 1000. */
const PAGE_SIZE = 1000;
/** Runaway guard — 2000 rows, matching the Zoho path's cap. */
const MAX_PAGES = 2;

/**
 * The org's invoices for a date window — including ones raised by hand in Xero,
 * which is the point: /finance reports the BUSINESS, not the panel.
 *
 * There is no `date_start`/`date_end` parameter; ranges go through `where` with
 * `DateTime(yyyy,mm,dd)` literals. `dateEnd` is INCLUSIVE at every call site
 * and Xero's `<` is exclusive, so the upper bound is the day after.
 *
 * `status: "unpaid"` becomes `Statuses=AUTHORISED`. Zoho's `Status.Unpaid` was
 * sent + viewed + overdue + partially paid; under Xero all four of those live
 * inside the single `AUTHORISED` status. Xero recommends the explicit
 * `Statuses=` parameter over an `OR` in `where` for response time.
 *
 * `truncated` comes from Xero's own `pagination.pageCount` rather than from a
 * has-more-page heuristic — an exact signal, and the reason this path does NOT
 * pass `summaryOnly=true` (which drops the `pagination` object entirely, after
 * which truncation could only be inferred by paging to exhaustion).
 */
export async function listInvoices(input: {
  dateStart?: string;
  dateEnd?: string;
  status?: "unpaid";
}): Promise<LedgerInvoiceList> {
  const today = ukTodayDate();
  const clauses = ['Type=="ACCREC"'];
  if (input.dateStart) clauses.push(`Date>=${dateTimeLiteral(input.dateStart)}`);
  if (input.dateEnd) clauses.push(`Date<${dateTimeLiteral(addDaysIso(input.dateEnd, 1))}`);

  const invoices: LedgerInvoiceListItem[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    // Hand-built for the same reason as the lookup above: one encoding pass,
    // and spaces as `%20` rather than `URLSearchParams`' form-encoded `+`.
    const params = [
      `page=${page}`,
      `pageSize=${PAGE_SIZE}`,
      `where=${encodeURIComponent(clauses.join(" AND "))}`,
      `order=${encodeURIComponent("Date DESC")}`,
    ];
    if (input.status === "unpaid") params.push("Statuses=AUTHORISED");

    const res = await xeroFetch(`/Invoices?${params.join("&")}`);
    const json = await xeroJson<XeroInvoicesResponse>(res, "invoice list");
    const rows = json.Invoices ?? [];

    for (const row of rows) {
      invoices.push({
        invoiceId: row.InvoiceID ?? "",
        invoiceNumber: row.InvoiceNumber ?? "",
        reference: row.Reference ?? "",
        customerName: row.Contact?.Name ?? "",
        date: xeroDay(row.DateString, row.Date),
        status: statusOf(row, today),
        total: num(row.Total),
        balance: num(row.AmountDue),
      });
    }

    const pageCount = json.pagination?.pageCount;
    if (pageCount == null) {
      // No pagination object means we cannot prove we saw everything. A full
      // page with no way to check is reported as truncated rather than as
      // complete: money figures built from a short list must SAY so instead of
      // silently understating.
      if (rows.length >= PAGE_SIZE) {
        truncated = true;
        log.warn("ledger.xero.list_pagination_missing", { page, rows: rows.length });
      }
      break;
    }
    if (page >= pageCount) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { invoices, truncated };
}

/** `DateTime(2026,08,01)` — the only date-range form Xero's `where` accepts. */
function dateTimeLiteral(day: string): string {
  const [y, m, d] = day.split("-");
  return `DateTime(${y},${m},${d})`;
}

/**
 * Read one invoice by the id we stored, possibly months ago.
 *
 * A stale or foreign id fails LOUDLY: Xero 404s a well-formed-but-unknown id,
 * so a mis-routed poll throws rather than quietly reporting a paid customer as
 * unpaid. The 404 body is `text/html`, which is why {@link xeroFail} branches
 * on status before parsing.
 *
 * `invoiceUrl` is null here on purpose. The hosted URL needs its own call, this
 * runs on every open invoice on every cron pass, and nothing downstream reads
 * the URL off a status poll — only off a create or an adoption.
 */
export async function getInvoiceStatus(invoiceId: string): Promise<LedgerInvoiceStatus> {
  const row = await readOneInvoice(invoiceId);
  return {
    invoiceId: row.InvoiceID ?? invoiceId,
    invoiceNumber: row.InvoiceNumber ?? "",
    invoiceUrl: null,
    status: statusOf(row, ukTodayDate()),
    total: num(row.Total),
    balance: num(row.AmountDue),
  };
}

/**
 * `GET /Invoices/{id}` — the response is an ARRAY of one, like `/Organisation`.
 *
 * The only producer of {@link SingleInvoiceRead}. That is the point: see
 * {@link invoiceCarriesVat}.
 */
async function readOneInvoice(invoiceId: string): Promise<SingleInvoiceRead> {
  const res = await xeroFetch(`/Invoices/${encodeURIComponent(invoiceId)}`);
  const json = await xeroJson<XeroInvoicesResponse>(res, `invoice read ${invoiceId}`);
  const row = json.Invoices?.[0];
  if (!row) {
    throw new LedgerError(`Xero returned no invoice for id ${invoiceId}.`, undefined, res.status);
  }
  return row as SingleInvoiceRead;
}

/**
 * Does this invoice carry a VAT treatment? Gates whether a credit note reverses
 * VAT, so a wrong answer misstates a VAT return.
 *
 * **It reads a SINGLE invoice, and the type system makes that mandatory.**
 * This is not tidiness. Xero documents that a list read excludes `LineItems` —
 * and it does not: on both a plain list row and a `summaryOnly` row the key is
 * PRESENT with an EMPTY ARRAY. So the natural `(inv.LineItems ?? []).some(...)`
 * over a list row evaluates to `false` rather than throwing or returning
 * undefined. `TotalTax > 0` still catches the ordinary 20% case, so the only
 * case that breaks is zero-rated or exempt — precisely the case the line check
 * exists to catch, arriving as a confident "no VAT". Hence
 * {@link SingleInvoiceRead}: a list row is a compile error, not a judgement
 * call at a future call site.
 *
 * Both signals are needed, and neither is sufficient:
 *
 * - `TotalTax > 0` catches standard-rated supplies.
 * - It is WRONG at 0%: a zero-rated or exempt supply carries a VAT treatment
 *   and belongs on the return, but reports `TotalTax: 0.00`. The UK zero/exempt
 *   output types are `ZERORATEDOUTPUT`, `ECZROUTPUT`, `ECZROUTPUTSERVICES` and
 *   `EXEMPTOUTPUT`.
 * - `TaxType` is ALWAYS present on a Xero line (unlike Zoho's `tax_id`, which
 *   is simply absent when there is no tax), so the discriminator is
 *   `TaxType !== "NONE"` rather than "does the line have a tax handle".
 *
 * An invoice that comes back with no lines at all is refused rather than
 * answered. A single read of a real invoice always has lines; if one does not,
 * we are looking at a partial picture, and "I could not check" must not render
 * as "no VAT".
 */
export async function invoiceCarriesVat(invoiceId: string): Promise<boolean> {
  return invoiceCarriesVatFrom(await readOneInvoice(invoiceId));
}

function invoiceCarriesVatFrom(invoice: SingleInvoiceRead): boolean {
  const lines = invoice.LineItems ?? [];
  if (lines.length === 0) {
    throw new LedgerError(
      `Xero invoice ${invoice.InvoiceNumber ?? invoice.InvoiceID} came back with no line items, ` +
        `so its VAT treatment cannot be read. Refusing to answer — a wrong "no VAT" here would ` +
        `reverse VAT incorrectly on a credit note.`,
    );
  }
  if (num(invoice.TotalTax) > 0) return true;
  return lines.some((line) => (line.TaxType ?? "NONE") !== "NONE");
}

/**
 * The invoice PDF, base64-encoded, for attaching to a customer email.
 *
 * **The path in Xero's own OpenAPI spec does not exist.**
 * `GET /Invoices/{id}/pdf` 404s with an empty body; the PDF comes from the
 * ordinary invoice URL with `Accept: application/pdf` (verified live twice,
 * 135876 bytes, `%PDF-1.7`). The yaml declares the `/pdf` path but decorates
 * the operation with `x-path: /Invoices/{InvoiceID}` — the extension is the
 * truth and the path key is a codegen artifact.
 *
 * The magic-byte check is not paranoia: without it a JSON error body served
 * under a 200 would be base64-encoded and emailed to a customer as an invoice.
 */
export async function getInvoicePdfBase64(invoiceId: string): Promise<string> {
  const res = await xeroFetch(`/Invoices/${encodeURIComponent(invoiceId)}`, {}, "application/pdf");
  if (!res.ok) await xeroFail(res, `invoice PDF ${invoiceId}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new LedgerError(
      `Xero returned a ${bytes.length}-byte response for invoice ${invoiceId} that is not a PDF ` +
        `(content-type ${res.headers.get("content-type") ?? "unknown"}).`,
    );
  }
  return bytes.toString("base64");
}

/**
 * Record money received against an invoice.
 *
 * Xero has **no payment-mode field** — `PaymentType` is read-only and derived,
 * and `Details`/`Particulars`/`BankAccountNumber` are supplier-side fields. The
 * ACCOUNT is the record of the rail, so `mode` resolves to an org-specific bank
 * account id from config. Getting that mapping wrong puts real customer money
 * in the wrong nominal account, which is why the ids are never hardcoded and an
 * unconfigured mode fails closed naming its env var.
 *
 * `input.customerId` is genuinely unused: a Xero payment carries no contact,
 * the contact is implied by the invoice. It stays on the interface because Zoho
 * requires it.
 *
 * `Reference` here is free text ("an optional description for the payment") and
 * does not participate in the invoice-reference lookup, so carrying our quote
 * reference on it is safe.
 */
export async function recordInvoicePayment(input: RecordPaymentInput): Promise<string> {
  await assertXeroWritable(`record a ${input.mode} payment against invoice ${input.invoiceId}`);

  const body = {
    Payments: [
      {
        Invoice: { InvoiceID: input.invoiceId },
        // AccountID, not Code: Code is user-editable in the Chart of Accounts
        // UI and Xero notes that not every account has one.
        Account: { AccountID: xeroPaymentAccountId(input.mode) },
        Amount: round2(input.amount),
        Date: input.date ?? ukTodayDate(),
        ...(input.reference ? { Reference: input.reference } : {}),
      },
    ],
  };

  const res = await xeroFetch(
    "/Payments",
    writeInit(body, `payment|${input.invoiceId}|${round2(input.amount)}|${input.date ?? ukTodayDate()}`),
  );
  const json = await xeroJson<{ Payments?: (XeroWriteElement & { PaymentID?: string })[] }>(
    res,
    `payment against invoice ${input.invoiceId}`,
  );
  const payment = json.Payments?.[0];
  assertWriteAccepted(payment, `payment against invoice ${input.invoiceId}`, payment?.PaymentID);
  return payment!.PaymentID!;
}

/**
 * Void an invoice — used when a lead is marked lost.
 *
 * The read-first guard is ours and is deliberately stricter than Xero's. Xero
 * refuses a void only when payments or credit notes are ALLOCATED; we refuse
 * whenever any money has landed, and the message
 * `Refusing to void <n>: payment already applied` is read by a human in an ops
 * alert and is pinned by the Zoho tests. It must survive the seam byte for
 * byte, so it is reproduced here rather than replaced by Xero's wording.
 *
 * Xero's own refusal (HTTP 400, `ErrorNumber 10`, `ValidationException`,
 * "Invoice not of valid status for modification") is the belt-and-braces second
 * line. Its text is carried through as DISPLAY only — never branched on, since
 * `ValidationError` has no code and the prose is Xero's to rewrite.
 *
 * Only `AUTHORISED → VOIDED` is a valid transition; drafts go to `DELETED` and
 * a `PAID` invoice has no outbound transition at all.
 */
export async function voidInvoice(invoiceId: string): Promise<void> {
  await assertXeroWritable(`void invoice ${invoiceId}`);

  const status = await getInvoiceStatus(invoiceId);
  if (status.status === "void") return; // already done
  if (status.status === "paid" || status.balance < status.total) {
    throw new LedgerError(`Refusing to void ${status.invoiceNumber}: payment already applied`);
  }

  const res = await xeroFetch(`/Invoices/${encodeURIComponent(invoiceId)}`, {
    method: "POST",
    body: JSON.stringify({ Invoices: [{ InvoiceID: invoiceId, Status: "VOIDED" }] }),
  });
  const json = await xeroJson<XeroInvoicesResponse>(res, `void of ${status.invoiceNumber}`);
  const voided = json.Invoices?.[0];
  assertWriteAccepted(voided, `void of ${status.invoiceNumber}`, voided?.InvoiceID);
  if (voided?.Status !== "VOIDED") {
    throw new LedgerError(
      `Xero accepted the void of ${status.invoiceNumber} but the invoice reads ` +
        `${voided?.Status ?? "an unknown status"} — refusing to report it as voided.`,
    );
  }
}

/**
 * The OFFICE deep link for an invoice — the "open in Xero" button on /finance.
 *
 * **Synchronous by contract**: called inside `.map()` in a non-async server
 * component, so it cannot fetch. The org short code is therefore configuration,
 * exactly as `zohoInvoiceAppUrl` reads `ZOHO_ORG_ID`. It also changes on every
 * 28-day Demo Company reset, so the bootstrap script re-stamps it.
 *
 * `xeroOrgShortCode()` throws when it is unset, and this function is contracted
 * to return a string, so the throw is caught here and turned into an inert
 * fragment: clicking it does nothing visible. Both halves of that are
 * deliberate. Letting it throw would take down the whole /finance render over a
 * missing deep link; emitting the URL with an empty short code would produce a
 * link that LOOKS valid and drops office staff into whichever organisation
 * their Xero session happens to have open — which, for someone who also has
 * other companies' books in Xero, is worse than a dead button. Never guess a
 * short code.
 *
 * Form note: this is the `organisationlogin` deep link, quoted verbatim from
 * Xero's own deep-link guide, and it is the form that forces the correct
 * organisation to be selected first. A second recon pass preferred the modern
 * `go.xero.com/app/{shortCode}/invoicing/view/{id}` SPA route, which is
 * genuinely present in Xero's published MCP server source. Neither has been
 * clicked while logged in. Worth one manual click before the cutover — the
 * disagreement is about which route is current, not about the short code.
 */
export function invoiceAppUrl(invoiceId: string): string {
  let shortCode: string;
  try {
    shortCode = xeroOrgShortCode();
  } catch {
    return "#xero-org-shortcode-not-configured";
  }
  return (
    `https://go.xero.com/organisationlogin/default.aspx?shortcode=${shortCode}` +
    `&redirecturl=/AccountsReceivable/View.aspx?InvoiceID=${invoiceId}`
  );
}
