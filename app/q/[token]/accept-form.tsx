"use client";

/**
 * The customer-facing accept form: typed full name = the acceptance signature.
 * Mobile-first (the link arrives by email/SMS/QR), 56px touch targets.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { acceptQuoteAction } from "./actions";

export function AcceptForm({ token, depositLabel }: { token: string; depositLabel: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) {
      setError("Type your full name to accept the quote.");
      return;
    }
    startTransition(async () => {
      const res = await acceptQuoteAction(token, name.trim());
      if (!res.ok) setError(res.error);
      else router.refresh(); // server re-renders into the payment view
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label
          htmlFor="accept-name"
          className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-mist-400"
        >
          Your full name
        </label>
        <input
          id="accept-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="e.g. Jane Smith"
          className="h-14 w-full rounded-md border border-mist-200 bg-white px-4 text-base text-ink outline-none transition focus:border-mm-red focus:ring-2 focus:ring-mm-red/20"
        />
        <p className="mt-2 text-xs text-mist-400">
          Typing your name acts as your signature accepting this quote and our{" "}
          <a
            href="https://marleymoves.co.uk/terms-conditions/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-mist-500 underline underline-offset-2"
          >
            terms &amp; conditions
          </a>
          .
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger"
        >
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-md bg-mm-red text-base font-semibold text-white transition hover:bg-mm-red-deep active:scale-[0.99] disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-5 animate-spin" strokeWidth={2} /> : null}
        {pending ? "Accepting…" : `Accept quote & pay ${depositLabel} deposit`}
      </button>
    </form>
  );
}
