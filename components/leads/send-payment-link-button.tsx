"use client";

import { useState, useTransition } from "react";
import { CreditCard, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { sendPaymentLinkAction } from "@/app/actions/card-payments";

/**
 * Gate 9d (PRD §3.10) — "Send payment link".
 *
 * For the customer who phones in unable to do a bank transfer: the office sends
 * them a card page rather than reading card details over the phone.
 *
 * Rendered only where the server has already resolved eligibility through
 * `paymentLinkFor`, which includes `cardPaymentsAvailable(sb, brand)` — so a
 * brand with card switched off never sees this button, and the word "card"
 * never reaches one of its surfaces. The action re-checks the same rule anyway:
 * a rendered button is not evidence the switch is still on by the time it is
 * clicked.
 */
export function SendPaymentLinkButton({
  quoteId,
  amount,
  hasEmail,
  hasPhone,
}: {
  quoteId: string;
  /** Pounds, for the confirm copy — the office should see what will be asked. */
  amount: number;
  hasEmail: boolean;
  hasPhone: boolean;
}) {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);

  if (!hasEmail && !hasPhone) return null;

  const send = (channel: "email" | "sms") => {
    const via = channel === "email" ? "email" : "text";
    if (!confirm(`Send a card payment link for £${amount.toFixed(2)} by ${via}?`)) return;
    start(async () => {
      const res = await sendPaymentLinkAction({ quoteId, channel });
      if (res.ok) {
        setSent(true);
        toast.success(`Payment link sent to ${res.sentTo}`);
      } else {
        // The rule's refusal reasons are written for the office, so show them
        // rather than a generic failure.
        toast.error(res.error);
      }
    });
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      {hasEmail ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => send("email")}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
          ) : (
            <CreditCard className="size-3.5" strokeWidth={2} />
          )}
          {sent ? "Link sent" : "Send payment link"}
        </button>
      ) : null}
      {hasPhone ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => send("sms")}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          Text it
        </button>
      ) : null}
    </span>
  );
}
