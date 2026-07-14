"use client";

/**
 * Re-send an already-sent (or accepted) quote email — the customer asked for it
 * again. Reuses the exact send path (SendQuoteDialog → sendCommunication →
 * dispatchComm), so the branded email + PDF are identical to the original; the
 * duplicate guard therefore fires and the dialog asks to confirm before
 * re-sending with override (reason "customer requested re-send"). `resend` keeps
 * the quote's status unchanged (an accepted quote must not drop back to "sent").
 */

import { useMemo, useState } from "react";
import { Mail } from "lucide-react";
import { computeQuote, type PricingConfig } from "@/lib/quote/pricing";
import { deriveInputs, type QuoteFormValues } from "@/lib/quote/form-types";
import { SendQuoteDialog } from "@/components/quote/send-quote-dialog";
import { useRouter } from "next/navigation";

export function ResendQuoteButton({
  quoteId,
  quoteRef,
  values,
  pricing,
  leadId,
  clientId,
  leadEmail,
  estimatorName,
  vatNumber,
  depositAmount,
  acceptUrl,
  open: openProp,
  onOpenChange,
}: {
  quoteId: string;
  quoteRef: string;
  values: QuoteFormValues;
  pricing: PricingConfig;
  leadId?: string | null;
  clientId?: string | null;
  /** The lead's stored email — the baseline for the "Send to" correction offer. */
  leadEmail?: string | null;
  estimatorName?: string | null;
  vatNumber?: string;
  depositAmount?: number;
  acceptUrl?: string;
  /** Controlled mode: when `open`/`onOpenChange` are supplied the built-in
   *  trigger is suppressed and the dialog is driven from outside (the quote
   *  header opens it from its "⋯ More" overflow menu). */
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const router = useRouter();
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? openProp : openState;
  const setOpen = controlled ? (onOpenChange ?? (() => {})) : setOpenState;
  const breakdown = useMemo(() => computeQuote(deriveInputs(values), pricing), [values, pricing]);

  return (
    <>
      {controlled ? null : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-semibold text-foreground hover:bg-muted"
        >
          <Mail className="size-3.5 text-mm-red" strokeWidth={2} />
          Re-send quote email
        </button>
      )}
      <SendQuoteDialog
        open={open}
        onOpenChange={setOpen}
        quoteId={quoteId}
        quoteRef={quoteRef}
        values={values}
        breakdown={breakdown}
        leadId={leadId}
        clientId={clientId}
        leadEmail={leadEmail}
        estimatorName={estimatorName}
        vatNumber={vatNumber}
        depositAmount={depositAmount}
        acceptUrl={acceptUrl}
        resend
        onSent={() => router.refresh()}
      />
    </>
  );
}
