"use client";

/**
 * "Pay deposit by card" — mints a signed hosted-payment request server-side,
 * then hands the browser to the takepayments Hosted Payment Page via an
 * auto-submitted form (the HPP only accepts a browser POST; there is no
 * link-minting API). Card details are typed on takepayments' page, never ours.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { startCardPaymentAction } from "./actions";

export function PayCardButton({ token, amountLabel }: { token: string; amountLabel: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await startCardPaymentAction(token);
    if (!res.ok) {
      setError(res.error || "Something went wrong — please try again or pay by bank transfer.");
      setBusy(false);
      return;
    }
    // Build + submit the signed form — full-page navigation to the HPP.
    const form = document.createElement("form");
    form.method = "POST";
    form.action = res.url;
    for (const [name, value] of Object.entries(res.fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    // Keep the spinner while the browser navigates away.
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={pay}
        disabled={busy}
        className="flex h-14 w-full items-center justify-center rounded-md bg-mm-red text-base font-semibold text-white transition hover:bg-mm-red-deep active:scale-[0.99] disabled:opacity-70"
      >
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-5 animate-spin" strokeWidth={2} />
            Taking you to secure payment…
          </span>
        ) : (
          <>Pay {amountLabel} deposit by card →</>
        )}
      </button>
      <p className="text-center text-xs text-mist-400">
        Secure payment page · Visa, Mastercard and major debit cards
      </p>
      {error ? <p className="text-center text-sm font-medium text-mm-red">{error}</p> : null}
    </div>
  );
}
