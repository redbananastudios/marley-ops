"use client";

/**
 * The customer-facing accept form: typed full name = the acceptance signature,
 * plus the three contract acknowledgments (one signature, several protections
 * — Peter, 2026-07-10). Mobile-first (the link arrives by email/SMS/QR),
 * 56px touch targets, no account, no app.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { CONTRACT_ACKS, type ContractAckKey } from "@/lib/signatures";
import { ScriptSignature, renderNameToPng } from "@/lib/signature-script";
import { acceptQuoteAction } from "./actions";

export function AcceptForm({
  token,
  depositLabel,
  termsUrl,
}: {
  token: string;
  depositLabel: string;
  /** The brand's OWN terms (gate 16). This link is the document the customer
   *  is signing, so a hardcoded one had a second brand's customer agreeing to
   *  the default brand's terms — on the default brand's domain. */
  termsUrl: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [acks, setAcks] = useState<Record<ContractAckKey, boolean>>({
    inventory: false,
    owner_packed: false,
    no_hazardous: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const allTicked = CONTRACT_ACKS.every((a) => acks[a.key]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) {
      setError("Type your full name to accept the quote.");
      return;
    }
    if (!allTicked) {
      setError("Please tick each confirmation box — it protects your belongings and your move.");
      return;
    }
    startTransition(async () => {
      // Rasterise the script rendering so the record carries a signature
      // image; the typed name stays the legal signature if this fails.
      const sigImage = await renderNameToPng(name);
      const res = await acceptQuoteAction(token, name.trim(), acks, sigImage);
      if (!res.ok) setError(res.error);
      else router.refresh(); // server re-renders into the payment view
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2.5">
        {CONTRACT_ACKS.map((a) => (
          <label
            key={a.key}
            className="flex min-h-14 cursor-pointer items-center gap-3 rounded-md border border-mist-200 bg-white px-4 py-3 transition has-[:checked]:border-mm-red/50 has-[:checked]:bg-mm-red/[0.03]"
          >
            <input
              type="checkbox"
              checked={acks[a.key]}
              onChange={(e) => {
                setAcks((s) => ({ ...s, [a.key]: e.target.checked }));
                setError(null);
              }}
              className="size-5 shrink-0 accent-mm-red"
            />
            <span className="text-sm leading-snug text-ink">{a.label}</span>
          </label>
        ))}
      </div>

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
        <div className="mt-3">
          <ScriptSignature name={name} />
        </div>
        <p className="mt-2 text-xs text-mist-400">
          Typing your name acts as your signature accepting this quote and our{" "}
          <a
            href={termsUrl}
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
