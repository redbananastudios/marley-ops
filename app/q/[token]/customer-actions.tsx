"use client";

/**
 * Customer-side secondary actions on the /q page:
 *  - DeclineOption: "not going ahead" with a reason — collapsible so it never
 *    competes with the accept CTA, but honest customers get a one-tap out that
 *    feeds our loss reasons and stops the reminder emails.
 *  - DepositSentButton: "I've sent the bank transfer" self-report — pauses the
 *    reminders and puts a check-the-bank task in front of the team.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { declineQuoteAction, reportDepositSentAction } from "./actions";

const REASONS = [
  { value: "too_expensive", label: "The price didn't work for us" },
  { value: "chose_competitor", label: "We've gone with another company" },
  { value: "move_fell_through", label: "The move fell through" },
  { value: "dates_didnt_work", label: "The dates didn't work" },
  { value: "other", label: "Something else" },
];

export function DeclineOption({ token, phone }: { token: string; phone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!reason) {
      setError("Pick the closest reason.");
      return;
    }
    startTransition(async () => {
      const res = await declineQuoteAction(token, reason, note.trim() || undefined);
      if (!res.ok) setError(res.error ?? `Something went wrong — please call ${phone}.`);
      else router.refresh(); // server re-renders into the "thanks for telling us" view
    });
  }

  if (!open) {
    return (
      <p className="pt-1 text-center text-xs text-mist-400">
        Not going ahead?{" "}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-semibold text-mist-500 underline underline-offset-2 hover:text-ink"
        >
          Let us know
        </button>{" "}
        and we&apos;ll stop the reminders.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-mist-200 bg-mist-50 p-4">
      <p className="text-sm font-semibold text-ink">No problem — what swung it?</p>
      <div className="space-y-1.5">
        {REASONS.map((r) => (
          <label
            key={r.value}
            className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 text-sm ${
              reason === r.value ? "border-mm-red bg-white text-ink" : "border-mist-200 bg-white text-mist-500"
            }`}
          >
            <input
              type="radio"
              name="decline-reason"
              value={r.value}
              checked={reason === r.value}
              onChange={() => setReason(r.value)}
              className="size-4 accent-[#C03838]"
            />
            {r.label}
          </label>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Anything you'd like to add (optional)"
        className="w-full rounded-md border border-mist-200 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-mm-red"
      />
      {error ? <p className="text-sm text-mm-red">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="h-11 flex-1 rounded-md border border-mist-200 bg-white text-sm font-medium text-mist-500"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={pending}
          className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-charcoal text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : null}
          Decline the quote
        </button>
      </div>
    </form>
  );
}

export function DepositSentButton({ token, phone }: { token: string; phone: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await reportDepositSentAction(token);
      if (!res.ok) setError(res.error ?? `Something went wrong — please call ${phone}.`);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-md border border-mist-200 bg-white text-sm font-semibold text-ink transition hover:border-mm-red disabled:opacity-60"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={2} />
        ) : (
          <CheckCircle2 className="size-4 text-success" strokeWidth={2} />
        )}
        I&apos;ve sent the bank transfer
      </button>
      {error ? <p className="text-center text-sm text-mm-red">{error}</p> : null}
    </div>
  );
}
