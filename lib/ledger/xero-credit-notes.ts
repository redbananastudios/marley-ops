/**
 * Xero credit notes and refunds — SERVER ONLY.
 *
 * The VAT-reversal document for a refunded or cancelled supply, plus the
 * payment that moves the money back. Three of the thirteen `LedgerAdapter`
 * operations; the other ten live in `xero-invoices.ts`, whose HTTP plumbing
 * this file reuses so the write-safety assertions are identical on both paths.
 *
 * ## The one that is genuinely hard
 *
 * Zoho gives a credit note a `total_refunded_amount`, so "has this already been
 * refunded?" is one subtraction. **Xero has no refunds sub-resource and no such
 * field**, and its `RemainingCredit` is reduced by ALLOCATIONS to invoices just
 * as much as by refunds. So a straight port of Zoho's `available <= 0 ->
 * already_refunded` reports a refund as done when a human merely allocated the
 * credit against another invoice in the Xero UI — real customer money, silently
 * withheld, with the surface that would have shown the gap being the branch
 * that just cleared itself.
 *
 * The recon settled it live. `CreditNote.Payments` and `CreditNote.Allocations`
 * BOTH come back on a single GET, so the two causes are separately visible, and
 * the sentinel is built from the refund payments specifically. See
 * {@link refundCreditNote} for the four branches and why each one exists.
 */
import "server-only";

import { ukTodayDate } from "@/lib/finance/invoices";
import { log } from "@/lib/log";
import { xeroPaymentAccountId, xeroTaxType } from "./xero-config";
import { xeroFetch } from "./xero-client";
import {
  assertSafeReference,
  assertWriteAccepted,
  assertXeroWritable,
  num,
  round2,
  writeInit,
  xeroIncomeAccountCode,
  xeroJson,
  type XeroWriteElement,
} from "./xero-invoices";
import {
  ALREADY_REFUNDED,
  LedgerError,
  type CreateCreditNoteInput,
  type LedgerCreditNoteRef,
  type RefundCreditNoteInput,
} from "./types";

/**
 * `ACCRECCREDIT` — a credit note against a sales invoice.
 *
 * The OpenAPI autodocs summary says `ACCRECREDITNOTE`, which appears nowhere in
 * the spec itself and would be rejected. The enum is exactly
 * `[ACCPAYCREDIT, ACCRECCREDIT]`; `ACCPAYCREDIT` is the supplier side and is
 * never ours.
 */
const CREDIT_NOTE_TYPE = "ACCRECCREDIT";

/** Terminal statuses — a document that no longer represents anything owed. */
const DEAD_STATUSES = new Set(["VOIDED", "DELETED"]);

interface XeroCreditNoteRow extends XeroWriteElement {
  CreditNoteID?: string;
  CreditNoteNumber?: string;
  Reference?: string;
  Type?: string;
  Status?: string;
  Total?: number;
  /** Xero's own figure for what is left. Used only as a CHECKSUM — see below. */
  RemainingCredit?: number;
  /** Credit applied to other invoices. Not a refund. */
  Allocations?: { Amount?: number; Invoice?: { InvoiceNumber?: string } }[];
  /**
   * Refund payments. The nested objects carry no `Status` and no `PaymentType`
   * — which would be a problem if a reversed refund lingered here, and it does
   * not: deleting a refund payment removes it from this array entirely
   * (verified live on a note that stayed AUTHORISED throughout, so the result
   * is not an artefact of voiding). Summing this array is therefore an exact
   * count of LIVE refunds, with no filtering required.
   */
  Payments?: { PaymentID?: string; Amount?: number }[];
}

interface XeroCreditNotesResponse {
  CreditNotes?: XeroCreditNoteRow[];
}

/**
 * Adopt an existing credit note by our reference — the idempotency half of
 * never-create-twice, mirroring `findInvoiceByReference`.
 *
 * `where` is the only option here: `CreditNotes` has no `searchTerm` parameter
 * at all, which removes the substring trap by construction rather than by
 * discipline.
 *
 * Voided notes are still returned by a reference query — verified live, after
 * the probe voided its own note and the listing kept showing it. Adopting one
 * would mean refunding against a document that cannot take a refund, so they
 * are filtered out before the count. Two live matches is an error, never a
 * pick: Xero does not enforce a unique reference.
 */
export async function findCreditNoteByReference(
  reference: string,
): Promise<LedgerCreditNoteRef | null> {
  const value = assertSafeReference(reference);
  // One encoding pass, and spaces as `%20` — `URLSearchParams` would form-encode
  // the spaces around `AND` as `+`. Same reasoning as the invoice lookup.
  const clause = `Type=="${CREDIT_NOTE_TYPE}" AND Reference=="${value}"`;
  const res = await xeroFetch(`/CreditNotes?where=${encodeURIComponent(clause)}`);
  const json = await xeroJson<XeroCreditNotesResponse>(res, `credit-note lookup for ${value}`);

  const live = (json.CreditNotes ?? []).filter((cn) => !DEAD_STATUSES.has(cn.Status ?? ""));
  if (live.length === 0) return null;
  if (live.length > 1) {
    throw new LedgerError(
      `Xero holds ${live.length} live credit notes with reference ${value} ` +
        `(${live.map((c) => c.CreditNoteNumber ?? c.CreditNoteID).join(", ")}). Refusing to guess ` +
        `which one this refund belongs to — a human must void the duplicates in Xero.`,
    );
  }

  const cn = live[0];
  if (!cn.CreditNoteID) {
    throw new LedgerError(`Xero returned a credit note for ${value} with no CreditNoteID.`);
  }
  return { creditNoteId: cn.CreditNoteID, creditNoteNumber: cn.CreditNoteNumber ?? "" };
}

/**
 * Raise a credit note — the VAT-reversal document. This does NOT move money;
 * {@link refundCreditNote} records the cash going back.
 *
 * One call, unlike Zoho: `Status: "AUTHORISED"` in the create body lands it
 * authorised immediately, so there is no analogue of Zoho's defensive
 * `POST /creditnotes/{id}/status/open`.
 *
 * `applyVat` **mirrors the original invoice's treatment** rather than
 * re-deriving from the org's current rate, and `false` means no tax line even
 * if a rate now exists. That is not caution for its own sake: this org carries
 * four historic output-VAT types at three different percentages, and the
 * obvious-looking `OUTPUT` is 17.5% and DELETED while the live 20% one is
 * `OUTPUT2`. A reversal that re-derives "the current rate" can therefore
 * reverse a different amount of VAT than was charged.
 *
 * Both cases name their tax type from config, exactly as `createInvoice` does,
 * which is what keeps the reversal and the original document in step.
 */
export async function createCreditNote(input: CreateCreditNoteInput): Promise<LedgerCreditNoteRef> {
  const reference = assertSafeReference(input.reference);

  /**
   * Adopt an existing note before creating one — the behaviour `lib/zoho.ts`
   * implements internally and that the call site's own comment depends on
   * ("Create the credit note (idempotent by reference…)", refund-vat.ts:265).
   *
   * Xero does NOT enforce a unique Reference — the recon proved it by creating
   * three invoices sharing one — so without this a retry mints a SECOND note.
   * The concrete run: a card deposit refund commits in Xero but the response
   * dies on the wire, the caller records nothing, the office presses Refund
   * again, and because the reference is derived from a stable idemKey it is
   * byte-identical. Two ACCRECCREDIT notes for one refund reclaims the output
   * VAT twice, and from then on `findCreditNoteByReference` correctly refuses
   * two live matches — so the recovery path reports "no existing credit note"
   * and a human is told to raise a third.
   *
   * Sits BELOW the writability guard on purpose: this is a write operation, and
   * refusing to touch the live books before doing any work at all is what keeps
   * that refusal absolute rather than conditional on what happens to exist.
   */
  await assertXeroWritable(`create credit note ${reference}`);

  const existing = await findCreditNoteByReference(reference);
  if (existing) {
    log.info("ledger.xero.credit_note_adopted", { reference, creditNoteId: existing.creditNoteId });
    return existing;
  }

  const body = {
    CreditNotes: [
      {
        Type: CREDIT_NOTE_TYPE,
        Contact: { ContactID: input.customerId },
        Date: input.date ?? ukTodayDate(),
        Status: "AUTHORISED",
        // Our `amount` is the gross figure being refunded, so the document must
        // read it as VAT-INCLUSIVE. Xero's documented default is EXCLUSIVE:
        // omitting this would credit 20% more than was ever charged.
        LineAmountTypes: "Inclusive",
        Reference: reference,
        LineItems: [
          {
            Description: input.notes
              ? `${input.description} — ${input.notes}`
              : input.description,
            Quantity: 1,
            UnitAmount: round2(input.amount),
            AccountCode: xeroIncomeAccountCode(input.itemName),
            // `applyVat === false` names the org's explicit no-VAT type rather
            // than omitting the field: an omitted TaxType inherits the
            // account's default, which is the 20% one — so omission would
            // reverse VAT that was never charged.
            TaxType: xeroTaxType(input.applyVat !== false),
          },
        ],
      },
    ],
  };

  const res = await xeroFetch("/CreditNotes", writeInit(body, `creditnote-create|${reference}`));
  const json = await xeroJson<XeroCreditNotesResponse>(res, `credit-note create for ${reference}`);
  const created = json.CreditNotes?.[0];
  assertWriteAccepted(created, `credit-note create for ${reference}`, created?.CreditNoteID);

  return {
    creditNoteId: created!.CreditNoteID!,
    creditNoteNumber: created!.CreditNoteNumber ?? "",
  };
}

/** `GET /CreditNotes/{id}` — one read carries Allocations AND Payments. */
async function readCreditNote(creditNoteId: string): Promise<XeroCreditNoteRow> {
  const res = await xeroFetch(`/CreditNotes/${encodeURIComponent(creditNoteId)}`);
  const json = await xeroJson<XeroCreditNotesResponse>(res, `credit-note read ${creditNoteId}`);
  const cn = json.CreditNotes?.[0];
  if (!cn) {
    throw new LedgerError(
      `Xero returned no credit note for id ${creditNoteId}.`,
      undefined,
      res.status,
    );
  }
  return cn;
}

function sum(rows: { Amount?: number }[] | undefined): number {
  return round2((rows ?? []).reduce((acc, row) => acc + num(row.Amount), 0));
}

/**
 * Pay a refund back out against a credit note, and never twice.
 *
 * ## Why this is not Zoho's three lines
 *
 * Under Zoho, `available <= 0` means "already refunded", because the only thing
 * that consumes a credit note is a refund. Under Xero the same arithmetic has
 * two possible causes and they are not interchangeable:
 *
 * - **Refunded** — money left the bank. Returning the sentinel is right, and is
 *   what makes a retry safe.
 * - **Allocated** — a human applied the credit to another invoice in the Xero
 *   UI. No money moved. Returning the sentinel here would tell us a customer had
 *   been repaid when they had not. The recon found a real example in the demo
 *   org: `CN-0025`, `Status PAID`, `RemainingCredit 0.00`, £541.25 allocated to
 *   an invoice, zero payments. A Zoho-shaped guard reports £541.25 as refunded.
 *   Note also that `Status: "PAID"` on a credit note means "fully consumed", not
 *   "refunded" — it is not part of this guard at all.
 *
 * ## The four branches, in order
 *
 * 1. **Checksum.** The identity `RemainingCredit === Total − allocations −
 *    refunds` held on every record the recon read, so a disagreement means we
 *    are looking at a partial picture — most plausibly a future Xero response
 *    that trims one of the arrays, after which `refunded` silently reads 0 and
 *    branch 3 fires on a note that WAS refunded. Refuse and say so rather than
 *    choosing which figure to believe.
 * 2. **Already refunded.** Requires refunds to actually cover the ask AND the
 *    note to be exhausted. `available <= 0` on its own never returns the
 *    sentinel.
 * 3. **Exhausted but not by us.** Its own outcome, and louder than the
 *    sentinel, because a human genuinely has to look. Not an error to swallow.
 * 4. **Over-refund.** Mirrors the Zoho message. Xero also enforces
 *    `Amount <= RemainingCredit` server-side, but that is a backstop: it cannot
 *    tell branch 2 from branch 3, and by the time it fires we have decided.
 */
export async function refundCreditNote(input: RefundCreditNoteInput): Promise<string> {
  await assertXeroWritable(`refund credit note ${input.creditNoteId}`);

  const want = round2(input.amount);
  if (want <= 0) {
    throw new LedgerError(
      `Refusing to refund £${want.toFixed(2)} against credit note ${input.creditNoteId}.`,
    );
  }

  const cn = await readCreditNote(input.creditNoteId);
  const label = cn.CreditNoteNumber ?? input.creditNoteId;
  if (DEAD_STATUSES.has(cn.Status ?? "")) {
    throw new LedgerError(
      `Credit note ${label} is ${cn.Status} in Xero and cannot take a refund — a human must ` +
        `raise a replacement before the money can go back.`,
    );
  }

  const total = round2(num(cn.Total));
  const remaining = round2(num(cn.RemainingCredit));
  const allocated = sum(cn.Allocations);
  const refunded = sum(cn.Payments);
  const available = round2(total - allocated - refunded);

  // 1. Two independent accounts of the same fact, and they may not disagree.
  if (Math.abs(available - remaining) > 0.005) {
    throw new LedgerError(
      `Credit note ${label}: Xero reports £${remaining.toFixed(2)} remaining, but its own ` +
        `figures give £${total.toFixed(2)} less £${allocated.toFixed(2)} allocated less ` +
        `£${refunded.toFixed(2)} refunded = £${available.toFixed(2)}. Refusing to decide whether ` +
        `it has already been refunded.`,
    );
  }

  // 2. Genuinely already done — the honest sentinel, and the reason a retry of
  //    a committed refund is safe rather than a second payment.
  if (refunded >= want && available <= 0) return ALREADY_REFUNDED;

  // 3. Nothing left, and none of it was refunded. Not the sentinel.
  if (available <= 0) {
    throw new LedgerError(
      `Credit note ${label} has no credit left, but £${refunded.toFixed(2)} of it was refunded ` +
        `and £${allocated.toFixed(2)} was allocated to another invoice in Xero. This is not an ` +
        `already-refunded case — a human must decide whether this customer is still owed money.`,
    );
  }

  // 4. Same wording as the Zoho path, which an operator has read before.
  if (want > available) {
    throw new LedgerError(
      `Credit note ${label} has only £${available.toFixed(2)} left to refund ` +
        `(asked £${want.toFixed(2)})`,
    );
  }

  const body = {
    Payments: [
      {
        // Exactly ONE identifier object per payment. `CreditNote`, never
        // `Invoice` — the same endpoint records both, and the identifier is the
        // only thing that says which direction the money is going.
        CreditNote: { CreditNoteID: input.creditNoteId },
        // The account IS the record of the rail: Xero has no payment-mode
        // field, so `mode` resolves to an org-specific account id from config.
        Account: { AccountID: xeroPaymentAccountId(input.mode) },
        Date: input.date ?? ukTodayDate(),
        Amount: want,
        // A payment's Reference is free text and is not queried by us, unlike
        // the invoice's and the credit note's, which must stay exactly the
        // quote reference for the where-clause re-map. `input.description` has
        // nowhere to go — a Xero payment has no description field — so it is
        // folded in here rather than dropped.
        ...(input.reference || input.description
          ? { Reference: [input.reference, input.description].filter(Boolean).join(" — ") }
          : {}),
      },
    ],
  };

  const res = await xeroFetch(
    "/Payments",
    writeInit(body, `creditnote-refund|${input.creditNoteId}|${want}`),
  );
  const json = await xeroJson<{ Payments?: (XeroWriteElement & { PaymentID?: string })[] }>(
    res,
    `refund of credit note ${label}`,
  );
  const payment = json.Payments?.[0];
  assertWriteAccepted(payment, `refund of credit note ${label}`, payment?.PaymentID);
  return payment!.PaymentID!;
}
