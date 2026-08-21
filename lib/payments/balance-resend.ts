/**
 * Whether an already-raised final invoice may be SENT AGAIN.
 *
 * Re-sending exists for the customer who wants to settle up before we would
 * have chased them, or who has lost the email (Greig James MMR015, 2026-08-20:
 * invoice raised 14 Aug, he replied five days later asking where to pay). It
 * re-sends the same invoice number, figure and PDF — a second invoice is never
 * created, because one job has one VAT document.
 *
 * Pure so the rule is testable away from Zoho and the mailer, and so the button
 * and the server refuse on identical grounds.
 *
 * The ladder itself lives in lib/payments/invoice-resend.ts and is shared with
 * the deposit and commitment rails; only the WORDS are the balance rail's own.
 * Every refusal string below is byte-identical to the one this file returned
 * when it carried its own copy of the ifs, and its tests pin each of them.
 */
import {
  invoiceResendVerdict,
  type InvoiceResend,
  type InvoiceResendFacts,
} from "@/lib/payments/invoice-resend";

export interface BalanceResendFacts extends Omit<InvoiceResendFacts, "paid"> {
  /** Settled. Never ask a paid customer to pay again. */
  balancePaid: boolean;
}

export type BalanceResend = InvoiceResend;

export function canResendBalanceInvoice(f: BalanceResendFacts): BalanceResend {
  return invoiceResendVerdict(
    { ...f, paid: f.balancePaid },
    {
      notRaised: "No final invoice has been raised yet — create it first.",
      cancelled: "This booking was cancelled — its final invoice will not be sent again.",
      commsLocked: "This is a legacy iMVE booking — turn its standard comms on before emailing them.",
      paidUnknown: "Could not check whether the balance is already paid.",
      paid: "The balance is already paid — nothing to send.",
      noEmail: "No email address on this job — add one first.",
      noAmount: "The invoiced balance is not recorded — check the invoice in Zoho.",
    },
  );
}
