"use client";

/**
 * Contractor-agreement signing UI — the /s remote-agreement pattern: the terms,
 * then a confirmation tick-box per acknowledgment, then a typed name rendered
 * live as a handwritten signature. Shared by the crew portal (/my-jobs/agreement)
 * and the estimator Settings card. On success it calls onSigned().
 */

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { CONTRACTOR_ACKS, CONTRACTOR_AGREEMENT, type ContractorAckKey } from "@/lib/contractor/agreement";
import { ScriptSignature, renderNameToPng } from "@/lib/signature-script";
import { signContractorAgreementAction } from "@/lib/contractor/sign-action";

const NONE = Object.fromEntries(CONTRACTOR_ACKS.map((a) => [a.key, false])) as Record<ContractorAckKey, boolean>;

export function ContractorAgreementSign({ onSigned }: { onSigned: () => void }) {
  const [name, setName] = useState("");
  const [acks, setAcks] = useState<Record<ContractorAckKey, boolean>>(NONE);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Type your full name to sign.");
    if (!CONTRACTOR_ACKS.every((a) => acks[a.key])) return setError("Please tick each confirmation box.");
    start(async () => {
      const sigImage = await renderNameToPng(name);
      const res = await signContractorAgreementAction({ name: name.trim(), acks, signatureImage: sigImage });
      if (!res.ok) setError(res.error ?? "Something went wrong — try again.");
      else onSigned();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="font-display text-lg font-semibold text-foreground">{CONTRACTOR_AGREEMENT.title}</h3>
        <p className="mt-1 text-sm text-mist-500">{CONTRACTOR_AGREEMENT.intro}</p>
        <div className="mt-3 space-y-3">
          {CONTRACTOR_AGREEMENT.clauses.map((c) => (
            <div key={c.heading}>
              <p className="text-sm font-semibold text-foreground">{c.heading}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-mist-500">{c.body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2.5">
        {CONTRACTOR_ACKS.map((a) => (
          <label
            key={a.key}
            className="flex min-h-14 cursor-pointer items-center gap-3 rounded-md border border-input bg-card px-4 py-3 transition has-[:checked]:border-mm-red/50 has-[:checked]:bg-mm-red/[0.03]"
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
            <span className="text-sm leading-snug text-foreground">{a.label}</span>
          </label>
        ))}
      </div>

      <div>
        <label htmlFor="contractor-sign-name" className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-mist-400">
          Your full name
        </label>
        <input
          id="contractor-sign-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="e.g. Jack Reed"
          className="focus-ring h-14 w-full rounded-md border border-input bg-card px-4 text-base text-foreground"
        />
        <div className="mt-3">
          <ScriptSignature name={name} />
        </div>
        <p className="mt-2 text-xs text-mist-400">Typing your name acts as your signature on this agreement.</p>
      </div>

      {error ? (
        <div role="alert" className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="focus-ring flex h-14 w-full items-center justify-center gap-2 rounded-md bg-mm-red text-base font-semibold text-white transition hover:bg-mm-red-deep active:scale-[0.99] disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-5 animate-spin" strokeWidth={2} /> : null}
        {pending ? "Signing…" : "Sign the contractor agreement"}
      </button>
    </form>
  );
}
