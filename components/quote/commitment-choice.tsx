"use client";

/**
 * "Pay 25% now, or settle in full" — the public /q commitment step (multi-brand
 * PRD §3.10 Addition 3, anatomy from the 2026-08-25 mock).
 *
 * Two selectable amount cards above a single bank-transfer block whose Amount
 * line follows the selection while the REFERENCE never changes. One reference,
 * two invoices: a single transfer covering both is the case the office's
 * whole-quote link already settles (#73, exact pennies, human-picked).
 *
 * Choosing "settle in full" raises the T-7 balance invoice early, so it is a
 * real server action rather than a display toggle. Three consequences shape
 * this component:
 *
 *  - **The default is 25%.** The ladder the customer agreed is what renders
 *    first; the other card is an offer, never a nudge.
 *  - **A failure returns the selection to 25%** and says so. A card that looks
 *    selected while no invoice was raised would have the customer transfer a
 *    figure nothing is expecting.
 *  - **Choosing full is not undone by switching back.** The invoice exists from
 *    then on; it was always going to at T-7. Selecting 25% again simply shows
 *    that amount, which they are still free to pay on its own — the invoices
 *    are individually matchable. The copy says so rather than implying the
 *    choice is locked.
 *
 * The balance rail takes no card (fees are too high at these values — Peter,
 * 2026-07-09), which is why this surface is bank-transfer only, exactly as the
 * commitment step is today.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { settleInFullAction } from "@/app/q/[token]/actions";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export interface CommitmentChoiceProps {
  token: string;
  quoteRef: string;
  /** The 25% commitment invoice amount (gross). */
  commitmentAmount: number;
  /** Pre-formatted due-date label, e.g. "Monday 13 July". Null = due now. */
  commitmentDueLabel: string | null;
  /** What would remain after the commitment — the T-7 balance. */
  balanceRemaining: number;
  /** Pre-formatted move-date label, for the balance card's footnote. */
  moveDateLabel: string | null;
  bank: { name: string; sortCode: string; account: string };
  /**
   * PRD §3.5 operating-company disclosure for the bank block — null for the
   * default brand, which IS the operating company (the same `theme.groupLine`
   * gate BankPanel uses on this page). REQUIRED rather than optional so a call
   * site cannot compile with it forgotten — which is exactly how this block
   * lost the sentence in the first place. Names arrive as data, never
   * literals: this is a shared surface under the brand-leak scan.
   */
  disclosure: { brandName: string; legalEntity: string } | null;
}

export function CommitmentChoice({
  token,
  quoteRef,
  commitmentAmount,
  commitmentDueLabel,
  balanceRemaining,
  moveDateLabel,
  bank,
  disclosure,
}: CommitmentChoiceProps) {
  const router = useRouter();
  const [choice, setChoice] = useState<"commitment" | "full">("commitment");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const full = commitmentAmount + balanceRemaining;
  const amountDue = choice === "full" ? full : commitmentAmount;

  function pick(next: "commitment" | "full") {
    setError(null);
    if (next === "commitment") {
      setChoice("commitment");
      return;
    }
    // Show the choice immediately, then confirm it server-side. On failure the
    // selection goes back rather than sitting on a figure nothing expects.
    setChoice("full");
    startTransition(async () => {
      const res = await settleInFullAction(token);
      if (!res.ok) {
        setChoice("commitment");
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  const card = (
    key: "commitment" | "full",
    label: string,
    amount: number,
    footnote: string,
  ) => {
    const selected = choice === key;
    return (
      <label
        className={`flex cursor-pointer items-start gap-3 rounded-md border p-4 transition ${
          selected ? "border-ink bg-white shadow-sm" : "border-mist-200 bg-mist-50"
        }`}
      >
        <input
          type="radio"
          name="commitment-choice"
          value={key}
          checked={selected}
          disabled={pending}
          onChange={() => pick(key)}
          className="mt-1 size-4 shrink-0 accent-mm-red"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold text-ink">{label}</span>
            <span className="font-display text-lg font-bold tabular text-ink">{gbp(amount)}</span>
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-mist-400">{footnote}</span>
        </span>
      </label>
    );
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2" role="radiogroup" aria-label="How much would you like to pay now?">
        {card(
          "commitment",
          "Pay 25% now",
          commitmentAmount,
          `${commitmentDueLabel ? `Due by ${commitmentDueLabel}` : "Due now"} · then ${gbp(
            balanceRemaining,
          )}${moveDateLabel ? ` before ${moveDateLabel}` : " before move day"}`,
        )}
        {card("full", "Settle in full", full, "Nothing more to pay before your move.")}
      </div>

      {pending ? (
        <p className="flex items-center gap-2 text-xs text-mist-400">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Preparing your final invoice…
        </p>
      ) : null}

      {error ? (
        <div className="rounded-md border border-warn-border bg-warn-bg p-3">
          <p className="text-sm leading-relaxed text-ink">{error}</p>
        </div>
      ) : null}

      <div className="rounded-md bg-mist-100 p-4">
        <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.16em] text-mist-500">
          Pay by bank transfer
        </p>
        <div className="divide-y divide-mist-200">
          {[
            ["Amount", gbp(amountDue), true] as const,
            ["Account name", bank.name, false] as const,
            ["Sort code", bank.sortCode, false] as const,
            ["Account number", bank.account, false] as const,
            ["Reference", quoteRef, true] as const,
          ].map(([label, value, accent]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist-400">
                {label}
              </span>
              <span className={`text-sm font-semibold ${accent ? "text-mm-red" : "text-ink"}`}>
                {value}
              </span>
            </div>
          ))}
        </div>
        {/* PRD §3.5 disclosure, beside the account name for the same reason
            BankPanel places it there: the surprise happens at the moment a
            non-default-brand customer reads an account name that is not the
            brand they booked with. */}
        {disclosure ? (
          <p className="mt-2 text-xs leading-relaxed text-mist-500">
            {disclosure.brandName} is part of {disclosure.legalEntity}, so your payment goes to
            the <strong className="text-ink">{bank.name}</strong> account above. Please use
            reference <strong className="text-ink">{quoteRef}</strong> so we can match it to your
            booking.
          </p>
        ) : null}
        <p className="mt-2 text-xs leading-relaxed text-mist-400">
          Please use the reference exactly as shown so we can match your payment. The reference is
          the same whichever amount you send. We&apos;ll email your confirmation as soon as it
          lands.
        </p>
      </div>
    </div>
  );
}
