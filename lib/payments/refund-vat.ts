/**
 * Refund → Zoho VAT reversal — SERVER ONLY. The shared money-out accounting path
 * for BOTH refund rails (Peter, 2026-07-28; go-live checklist C8).
 *
 * When a deposit is refunded/voided the customer gets their money back IN FULL
 * (never a held credit), and the output VAT already declared on that deposit must
 * be REVERSED or it's paid to HMRC on money we gave back. The Zoho instrument for
 * that is a credit note that is then REFUNDED (cash back) — NOT a customer
 * voucher. This module automates that: create the credit note, record its refund,
 * and email accounts@ to VERIFY. If anything Zoho-side fails, it falls back to a
 * tracked manual reminder — the money has ALREADY moved (card gateway / bank), so
 * this path must NEVER throw and never block the refund.
 *
 * Money movement is NOT done here:
 *   - CARD:  takepayments REFUND_SALE/CANCEL already returned the money (mode "creditcard").
 *   - BACS:  the operator already did the bank transfer (mode "banktransfer"/"cash").
 * This only records the reversal + reclaims the VAT.
 *
 * Forfeited/retained deposits keep their VAT (HMRC forfeited-deposit position) and
 * never reach here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { sendOpsAlert } from "@/lib/comms/dispatch";
import { asProvider, configuredProvider, createCreditNote, findCreditNoteByReference, findOrCreateContact, invoiceCarriesVat, refundCreditNote, reusableContactId, type LedgerCreditNoteRef, type LedgerParty } from "@/lib/ledger";

type Sb = SupabaseClient<Database>;

export type RefundMode = "creditcard" | "banktransfer" | "cash";

const money = (pence: number): string => `£${(Math.round(pence) / 100).toFixed(2)}`;

const modePhrase = (mode: RefundMode): string =>
  mode === "creditcard" ? "back to the card" : "by bank transfer";

/* --------------------------------------------------------------- pure content */

/**
 * Content for the accounts@ VERIFY email fired after a successful automated
 * reversal. Pure so the money-critical wording is unit-tested. The point of the
 * email (Peter's ask) is a human eyeball on every refund — confirm the credit
 * note + refund in Zoho AND that the money actually left.
 */
export function buildRefundVerifyAlert(input: {
  quoteRef: string;
  amountPence: number;
  creditNoteNumber: string;
  invoiceNumber: string | null;
  mode: RefundMode;
  voided: boolean;
  alreadyRefunded: boolean;
}): { subject: string; lines: string[] } {
  const amount = money(input.amountPence);
  const verb = input.voided ? "voided" : "refunded";
  return {
    subject: `VERIFY refund — ${amount} ${verb}, VAT reversed (${input.quoteRef})`,
    lines: [
      `A deposit ${input.voided ? "void" : "refund"} of <strong>${amount}</strong> for <strong>${input.quoteRef}</strong> has gone ${modePhrase(input.mode)}.`,
      `Zoho credit note <strong>${input.creditNoteNumber}</strong> was raised${input.invoiceNumber ? ` against deposit invoice ${input.invoiceNumber}` : ""} and its refund recorded — the output VAT is reversed in this VAT period.${input.alreadyRefunded ? " (Its refund was already recorded — no double entry.)" : ""}`,
      `Please VERIFY in Zoho: the credit note + refund are correct, and the money actually left${input.mode === "creditcard" ? " (takepayments)" : " (the bank)"}.`,
    ],
  };
}

/**
 * Content for the FALLBACK manual reminder, fired only when the automation could
 * not complete (Zoho unconfigured / API error). Pure. If a credit note WAS
 * already raised but its refund didn't record, the copy says so — a human must
 * record the refund on THAT note, never raise a second one.
 */
export function buildCreditNoteReminder(input: {
  quoteRef: string;
  invoiceNumber: string | null;
  amountPence: number;
  voided: boolean;
  mode: RefundMode;
  existingCreditNoteNumber?: string | null;
  error?: string | null;
}): { subject: string; lines: string[]; followUpNotes: string } {
  const amount = money(input.amountPence);
  const verb = input.voided ? "voided" : "refunded";
  const period = input.voided ? "void" : "refund";
  const invoiceRef = input.invoiceNumber
    ? `deposit invoice ${input.invoiceNumber}`
    : "the deposit invoice for this quote";
  const half = input.existingCreditNoteNumber
    ? `Credit note ${input.existingCreditNoteNumber} IS already raised but its refund did not record — RECORD THE REFUND on that note in Zoho (do NOT raise a second one).`
    : `Raise a credit note in Zoho against ${invoiceRef} and refund it, so the output VAT declared on the deposit is reversed and reclaimed in this VAT period.`;
  return {
    subject: `ACTION: finish the Zoho VAT reversal on a ${verb} deposit (${input.quoteRef})`,
    lines: [
      `A deposit ${verb} of <strong>${amount}</strong> for <strong>${input.quoteRef}</strong> went ${modePhrase(input.mode)}, but the automated Zoho reversal did NOT complete${input.error ? ` (${input.error})` : ""}.`,
      half,
      `Do it in the VAT period this ${period} falls in. A forfeited/retained deposit keeps its VAT — this is a genuine money-back ${verb} deposit.`,
    ],
    followUpNotes:
      (input.existingCreditNoteNumber
        ? `Zoho credit note ${input.existingCreditNoteNumber} is raised but its refund didn't record — record the ${amount} refund on it (do NOT raise a second). `
        : `Raise a Zoho credit note for ${amount} against ${input.invoiceNumber ?? "the deposit invoice"} and refund it to REVERSE the VAT on the ${verb} deposit (${input.quoteRef}). `) +
      `Automated reversal failed${input.error ? `: ${input.error}` : ""}. Action it in the VAT period the ${period} falls in. Forfeited/retained sums keep their VAT.`,
  };
}

/* --------------------------------------------------------------- IO shell */

/** Fallback: a tracked follow-up + accounts@ alert when the automation failed.
 *  Fully fail-soft — a failure here is money-critical, so it's logged loudly but
 *  never thrown (the refund itself already succeeded). */
async function raiseCreditNoteReminder(
  sb: Sb,
  input: {
    quoteId: string;
    leadId: string | null;
    clientId: string | null;
    quoteRef: string | null;
    invoiceNumber: string | null;
    amountPence: number;
    voided: boolean;
    mode: RefundMode;
    existingCreditNoteNumber?: string | null;
    error?: string | null;
  },
): Promise<void> {
  try {
    const content = buildCreditNoteReminder({
      quoteRef: input.quoteRef ?? input.quoteId.slice(0, 8),
      invoiceNumber: input.invoiceNumber,
      amountPence: input.amountPence,
      voided: input.voided,
      mode: input.mode,
      existingCreditNoteNumber: input.existingCreditNoteNumber,
      error: input.error,
    });
    if (input.leadId) {
      try {
        await sb.from("follow_ups").insert({
          lead_id: input.leadId,
          client_id: input.clientId,
          quote_id: input.quoteId,
          reason: "custom",
          due_at: new Date().toISOString(),
          source: "card_payment",
          // Distinguishes this accounting job from the refund-decision task that
          // shares (custom, card_payment) — see card-payments.ts. Also the key
          // the "Record credit note" action closes on.
          metadata: { kind: "credit_note" },
          notes: content.followUpNotes,
        } as never);
      } catch {
        /* the alert below is the backstop; a failed task insert must not abort it */
      }
    }
    await sendOpsAlert(content.subject, content.lines, "money");
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "refund_vat.reminder_failed",
        quote: input.quoteId,
        error: err instanceof Error ? err.message : "unknown",
      }),
    );
  }
}

export interface ReverseDepositVatInput {
  /** The refunded quote's id + display ref. */
  quoteId: string;
  quoteRef: string | null;
  /** Zoho linkage from the quote (may be null/"pending" on old rows). */
  zohoContactId: string | null;
  /** The original deposit invoice — REQUIRED to auto-reverse (its existence proves
   *  income was declared; its tax treatment is mirrored). Null ⇒ fall back to a
   *  human. */
  zohoDepositInvoiceId: string | null;
  /** Which ledger minted the two ids above (0109). A stored id carries no
   *  hint of its own origin, and after the cutover the configured provider is
   *  the WRONG place to look for either of them. */
  depositInvoiceProvider?: string | null;
  contactProvider?: string | null;
  zohoDepositInvoiceNumber: string | null;
  customerName: string | null;
  customerEmail: string | null;
  leadId: string | null;
  clientId: string | null;
  /** Amount returned to the customer, in pence. */
  amountPence: number;
  /** creditcard = card gateway refund; banktransfer/cash = manual BACS payout. */
  mode: RefundMode;
  /** Card same-day void vs a settled refund — wording only. */
  voided: boolean;
  /** Stable-per-refund-event key for the credit-note reference (idempotency). */
  idemKey: string;
  /** Persist the credit-note id back on the source row (card path). */
  onCreditNote?: (creditNoteId: string, creditNoteNumber: string) => Promise<void>;
}

export interface ReverseDepositVatResult {
  ok: boolean;
  creditNoteNumber?: string;
  /** True when the automation failed and the manual reminder was raised instead. */
  fellBack: boolean;
}

/**
 * Automate the VAT reversal for a money-back deposit refund/void: create the Zoho
 * credit note, record its refund (the money already moved), persist the note id,
 * and email accounts@ to verify. On ANY failure fall back to the manual reminder.
 * NEVER throws — the caller's money movement is already committed.
 */
export async function reverseDepositVatInZoho(
  sb: Sb,
  input: ReverseDepositVatInput,
): Promise<ReverseDepositVatResult> {
  const displayRef = input.quoteRef ?? input.quoteId.slice(0, 8);
  // Hoisted so the catch can ADOPT a note that was created-but-lost (a POST that
  // committed in Zoho then died on the wire) rather than telling a human to raise
  // a SECOND one for the same refund.
  const reference = `${displayRef}-CN-${input.idemKey}`.slice(0, 100);
  let createdCn: LedgerCreditNoteRef | null = null;
  try {
    if (!Number.isInteger(input.amountPence) || input.amountPence <= 0) {
      throw new Error(`bad refund amount ${input.amountPence}`);
    }

    // 1. There MUST be a real deposit invoice to reverse against. If the deposit
    //    was never invoiced in Zoho (creation failed / test row), there is no
    //    declared income or output VAT to reverse — auto-posting a standalone
    //    negative entry would corrupt the books, so hand it to a human instead.
    const realInvoiceId =
      input.zohoDepositInvoiceId && input.zohoDepositInvoiceId !== "pending"
        ? input.zohoDepositInvoiceId
        : null;
    if (!realInvoiceId) {
      throw new Error("no Zoho deposit invoice to reverse against — needs a human");
    }
    // MIRROR the original invoice's tax treatment (and prove it exists). Never
    // re-derive VAT from the org's CURRENT rate: a deposit invoiced before VAT was
    // enabled must reverse with NO VAT even after the rate is switched on, or we'd
    // reclaim VAT that was never declared.
    const applyVat = await invoiceCarriesVat(realInvoiceId, asProvider(input.depositInvoiceProvider));

    // 2. Resolve the Zoho contact (reuse the quote's, else find/create by identity).
    // A contact id is reusable only inside the ledger that minted it (0109) —
    // handing a Zoho contact to Xero's createCreditNote fails a reversal for
    // money that has ALREADY left the bank.
    const realContact = reusableContactId(
      input.zohoContactId,
      input.contactProvider,
      configuredProvider(),
    );
    // Keyed on the client where we have one, else on the quote — never on the
    // name. `quoteId` is non-nullable on this input, so a key always exists.
    const party: LedgerParty = input.clientId
      ? { kind: "client", id: input.clientId }
      : { kind: "quote", id: input.quoteId };
    const contactId =
      realContact ??
      (await findOrCreateContact({
        name: input.customerName || input.customerEmail || "Customer",
        email: input.customerEmail,
        party,
      }));

    // 3. Create the credit note (idempotent by reference; VAT mirrors the invoice).
    const amount = input.amountPence / 100;
    createdCn = await createCreditNote({
      customerId: contactId,
      reference,
      description: `Deposit ${input.voided ? "void" : "refund"} — ${displayRef}`,
      amount,
      applyVat,
      notes:
        `Automated VAT reversal for a ${input.voided ? "voided" : "refunded"} deposit; money returned ${modePhrase(input.mode)}.` +
        (input.zohoDepositInvoiceNumber ? ` Deposit invoice ref: ${input.zohoDepositInvoiceNumber}.` : ""),
    });

    // 4. Persist the id BEFORE recording the refund, so a crash mid-way leaves a
    //    recoverable trail (the reference lookup + refund balance-guard make a
    //    retry idempotent either way).
    if (input.onCreditNote) await input.onCreditNote(createdCn.creditNoteId, createdCn.creditNoteNumber);

    // 5. Record the refund against the note (money already left).
    const refundId = await refundCreditNote({
      creditNoteId: createdCn.creditNoteId,
      amount,
      mode: input.mode,
      reference: displayRef,
      description: `Deposit ${input.voided ? "void" : "refund"} — money returned ${modePhrase(input.mode)}`,
    });

    // 6. VERIFY email to accounts@ — the human safety net Peter asked for. If it
    //    can't send, leave a durable follow-up so the prompt is never silently lost.
    const alert = buildRefundVerifyAlert({
      quoteRef: displayRef,
      amountPence: input.amountPence,
      creditNoteNumber: createdCn.creditNoteNumber,
      invoiceNumber: input.zohoDepositInvoiceNumber,
      mode: input.mode,
      voided: input.voided,
      alreadyRefunded: refundId === "already_refunded",
    });
    const sent = await sendOpsAlert(alert.subject, alert.lines, "money");
    if (!sent && input.leadId) {
      try {
        await sb.from("follow_ups").insert({
          lead_id: input.leadId,
          client_id: input.clientId,
          quote_id: input.quoteId,
          reason: "custom",
          due_at: new Date().toISOString(),
          source: "card_payment",
          // Same accounting family as the reminder above, not the refund
          // decision — so the refund closer must not sweep it away.
          metadata: { kind: "credit_note", credit_note_number: createdCn.creditNoteNumber },
          notes: `Refund VAT reversal DONE (Zoho credit note ${createdCn.creditNoteNumber}, ${money(input.amountPence)}, ${displayRef}) but the accounts@ verify email FAILED to send — verify the credit note + refund in Zoho by hand.`,
        } as never);
      } catch {
        /* the alert attempt + its own reportOperationalIssue record are the backstop */
      }
    }
    return { ok: true, creditNoteNumber: createdCn.creditNoteNumber, fellBack: false };
  } catch (err) {
    // Money already moved — never propagate. Hand the VAT reversal to a human.
    // If a note was created-but-lost (POST committed then the response died), or
    // the refund failed on a freshly-created note, ADOPT it so accounts records the
    // refund on THAT note instead of raising a second → no double VAT reversal.
    const orphan = createdCn ?? (await findCreditNoteByReference(reference).catch(() => null));
    await raiseCreditNoteReminder(sb, {
      quoteId: input.quoteId,
      leadId: input.leadId,
      clientId: input.clientId,
      quoteRef: input.quoteRef,
      invoiceNumber: input.zohoDepositInvoiceNumber,
      amountPence: input.amountPence,
      voided: input.voided,
      mode: input.mode,
      existingCreditNoteNumber: orphan?.creditNoteNumber ?? null,
      error: err instanceof Error ? err.message : "unknown",
    });
    return { ok: false, fellBack: true };
  }
}
