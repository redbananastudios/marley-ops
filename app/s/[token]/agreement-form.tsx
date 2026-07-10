"use client";

/** Remote storage-agreement signing form — the /q pattern: acknowledgment
 *  tick-boxes + typed name rendered live as a handwritten signature. */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { STORAGE_ACKS, type StorageAckKey } from "@/lib/signatures";
import { ScriptSignature, renderNameToPng } from "@/lib/signature-script";
import { signStorageAgreementRemoteAction } from "./actions";

const NONE: Record<StorageAckKey, boolean> = { rate_advance: false, lien: false, no_prohibited: false };

export function StorageAgreementForm({ token }: { token: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [acks, setAcks] = useState(NONE);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Type your full name to sign the agreement.");
    if (!STORAGE_ACKS.every((a) => acks[a.key])) return setError("Please tick each confirmation box.");
    start(async () => {
      const sigImage = await renderNameToPng(name);
      const res = await signStorageAgreementRemoteAction(token, name.trim(), acks, sigImage);
      if (!res.ok) setError(res.error ?? "Something went wrong — call 01747 637070.");
      else router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2.5">
        {STORAGE_ACKS.map((a) => (
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
        <label htmlFor="sign-name" className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-mist-400">
          Your full name
        </label>
        <input
          id="sign-name"
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
        <p className="mt-2 text-xs text-mist-400">Typing your name acts as your signature on this storage agreement.</p>
      </div>

      {error ? (
        <div role="alert" className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-md bg-mm-red text-base font-semibold text-white transition hover:bg-mm-red-deep active:scale-[0.99] disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-5 animate-spin" strokeWidth={2} /> : null}
        {pending ? "Signing…" : "Sign the storage agreement"}
      </button>
    </form>
  );
}
