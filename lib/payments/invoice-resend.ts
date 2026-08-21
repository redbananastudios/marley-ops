/**
 * Whether an already-raised invoice may be SENT AGAIN — the rule shared by
 * every payment rail (deposit, commitment, balance).
 *
 * Re-sending exists for the customer who wants to settle up before we would
 * have chased them, or who has lost the email (Greig James MMR015, 2026-08-20:
 * balance invoice raised 14 Aug, he replied five days later asking where to
 * pay). It re-sends the SAME invoice number, figure and email — a second
 * invoice is never created, because one job has one VAT document.
 *
 * ONE implementation, three sets of copy. The bug that started this work was
 * two copies of a single sentence drifting apart (the balance email composing
 * itself from the deposit rail's payment block), so the rails deliberately do
 * not each carry their own ladder of ifs: they carry their own WORDS.
 *
 * Pure, so each refusal is provable without a database, and so the button and
 * the server refuse on identical grounds.
 */

export interface InvoiceResendFacts {
  /** Real Zoho invoice id — 'pending' is a CAS claim, not an invoice. */
  invoiceRaised: boolean;
  /** The figure on the raised invoice. */
  invoicedAmount: number;
  bookingCancelled: boolean;
  hasCustomerEmail: boolean;
  /** Settled. Never ask a paid customer to pay again. */
  paid: boolean;
  /**
   * The paid check could not be READ (a query error), which is not the same
   * answer as "not paid". Refuse: the cost of a wrong send here is a settled
   * customer being asked for money they have already handed over.
   */
  paidStateUnknown?: boolean;
  /**
   * Legacy iMVE booking whose standard comms are still switched off. These
   * customers were sold under the old system's terms and the panel must never
   * send them Marley's standard correspondence until the office has spoken to
   * them (lib/legacy.ts).
   */
  commsLocked?: boolean;
}

export type InvoiceResend = { ok: true } | { ok: false; reason: string };

/** One refusal sentence per rule, written in that rail's own language. */
export interface InvoiceResendCopy {
  notRaised: string;
  cancelled: string;
  commsLocked: string;
  paidUnknown: string;
  paid: string;
  noEmail: string;
  noAmount: string;
}

/**
 * Refusal ORDER is part of the contract: the money answer ("already paid",
 * "could not check") outranks a missing email, because it is the one the
 * operator most needs to hear, and a booking that has gone quiet (cancelled,
 * comms-locked) outranks everything except "there is no invoice at all".
 */
export function invoiceResendVerdict(f: InvoiceResendFacts, copy: InvoiceResendCopy): InvoiceResend {
  if (!f.invoiceRaised) return { ok: false, reason: copy.notRaised };
  if (f.bookingCancelled) return { ok: false, reason: copy.cancelled };
  // Settled-ness outranks the comms lock, even though BOTH refuse. The rung
  // that fires picks the WORDS the office reads, and only one of these two is
  // an end to the conversation. "Turn its standard comms on first" invites a
  // real state change on a live booking — and on prod today all three
  // legacy-locked bookings carrying a raised balance invoice are already PAID,
  // so lock-first would send the office to flip a toggle, lift automation on a
  // finished job, and only then learn there was nothing to send.
  if (f.paidStateUnknown) return { ok: false, reason: copy.paidUnknown };
  if (f.paid) return { ok: false, reason: copy.paid };
  if (f.commsLocked) return { ok: false, reason: copy.commsLocked };
  if (!f.hasCustomerEmail) return { ok: false, reason: copy.noEmail };
  // A raised invoice with no recorded figure means our copy of it is broken;
  // sending an email that names £0 (or omits the amount) is worse than saying so.
  if (!(f.invoicedAmount > 0)) return { ok: false, reason: copy.noAmount };
  return { ok: true };
}

/** Shared by every rail: a legacy booking is emailed only once the office has
 *  turned standard comms on for it. */
const LEGACY_LOCKED =
  "This is a legacy iMVE booking — turn its standard comms on before emailing them.";

/* ------------------------------------------------------------------ deposit */

export interface DepositResendFacts extends Omit<InvoiceResendFacts, "paid"> {
  /** The deposit is in. */
  depositPaid: boolean;
}

/**
 * Send the deposit payment email again — the same ask, the same payment link,
 * the same bank reference. It does not raise anything: the deposit invoice
 * already exists in Zoho and stays exactly as it is.
 */
export function canResendDepositInvoice(f: DepositResendFacts): InvoiceResend {
  return invoiceResendVerdict(
    { ...f, paid: f.depositPaid },
    {
      notRaised: "No deposit invoice has been raised yet — it retries by itself, or raise it in Zoho.",
      cancelled: "This booking was cancelled — its deposit will not be asked for again.",
      commsLocked: LEGACY_LOCKED,
      paidUnknown: "Could not check whether the deposit is already paid.",
      paid: "The deposit is already paid — nothing to send.",
      noEmail: "No email address on this job — add one first.",
      noAmount: "The deposit amount is not recorded — check the invoice in Zoho.",
    },
  );
}

/* --------------------------------------------------------------- commitment */

export interface CommitmentResendFacts extends Omit<InvoiceResendFacts, "paid"> {
  /** The 25% commitment is in. */
  commitmentPaid: boolean;
}

/**
 * Send the 25% commitment invoice again — the same invoice number, figure and
 * PDF the customer was sent when they confirmed their move date.
 */
export function canResendCommitmentInvoice(f: CommitmentResendFacts): InvoiceResend {
  return invoiceResendVerdict(
    { ...f, paid: f.commitmentPaid },
    {
      notRaised:
        "No commitment invoice has been raised yet — it is raised when the customer confirms their move date.",
      cancelled: "This booking was cancelled — its commitment invoice will not be sent again.",
      commsLocked: LEGACY_LOCKED,
      paidUnknown: "Could not check whether the commitment is already paid.",
      paid: "The commitment is already paid — nothing to send.",
      noEmail: "No email address on this job — add one first.",
      noAmount: "The invoiced commitment is not recorded — check the invoice in Zoho.",
    },
  );
}
