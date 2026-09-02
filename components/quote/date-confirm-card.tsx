"use client";

/**
 * "Confirm your move date" — the public /q card shown once the deposit is
 * paid and while the lead's date is unconfirmed (Payments Policy v2 §5A).
 * One tick (the DATE_CONFIRM ack carries the held/non-refundable position in
 * the customer's own words) + a typed-name signature, exactly the accept-form
 * pattern: the typed name is the signature, the script PNG is the evidence
 * image. Mobile-first, 56px touch targets.
 *
 * Copy rule: the word "penalty" never appears anywhere on this surface.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck2, Loader2 } from "lucide-react";
import { dateConfirmAcks, type DateConfirmAckKey } from "@/lib/signatures";
import { ScriptSignature, renderNameToPng } from "@/lib/signature-script";
import { confirmMoveDateAction } from "@/app/q/[token]/actions";

export function DateConfirmCard({
  token,
  moveDateLabel,
  companyName,
}: {
  token: string;
  /** Pre-formatted, e.g. "Monday 20 July". */
  moveDateLabel: string;
  /**
   * The company the acknowledgment names as the party that may retain up to
   * 25% of what the customer has paid — `pageTheme(...).name` from the page,
   * which resolves it from the QUOTE's brand. Every other element of this card
   * is already this brand's; the clause was the one that named the default
   * company on every brand's /q. Absent/blank falls back to the default
   * company, so a single-brand render is byte-identical.
   */
  companyName?: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [acks, setAcks] = useState<Record<DateConfirmAckKey, boolean>>({
    date_confirm: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ackList = useMemo(() => dateConfirmAcks(companyName), [companyName]);
  const allTicked = ackList.every((a) => acks[a.key]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) {
      setError("Type your full name to confirm your move date.");
      return;
    }
    if (!allTicked) {
      setError("Please tick the confirmation box first.");
      return;
    }
    startTransition(async () => {
      const sigImage = await renderNameToPng(name);
      const res = await confirmMoveDateAction(token, name.trim(), acks, sigImage);
      if (!res.ok) setError(res.error);
      else router.refresh(); // server re-renders into the confirmed view
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-start gap-3">
        <CalendarCheck2 className="mt-0.5 size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-brand text-xl font-semibold text-ink">Confirm your move date</h2>
          <p className="mt-1 text-sm leading-relaxed text-mist-500">
            Your move is booked for <strong className="text-ink">{moveDateLabel}</strong>.
            Confirming locks the date in for you and reserves the crew. It also means your
            deposit stops being refundable, so please only confirm once you&apos;re sure.
          </p>
        </div>
      </div>

      <div className="space-y-2.5">
        {ackList.map((a) => (
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
          htmlFor="date-confirm-name"
          className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-mist-400"
        >
          Your full name
        </label>
        <input
          id="date-confirm-name"
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
          Typing your name acts as your signature confirming this move date.
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
        {pending ? "Confirming…" : "Confirm my move date"}
      </button>
    </form>
  );
}
