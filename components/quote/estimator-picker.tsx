"use client";

/**
 * Assign a quote to its estimator — this decides who the quote EMAIL fronts
 * (lib/comms/sender.ownerIdentity -> "Luke at Marley Moves <luke@marleymoves.co.uk>")
 * and, as a fallback, pay attribution. "Office / Accounts (no personal sender)"
 * clears the estimator (null) so an un-triaged quote emails from the Accounts
 * money desk, never whichever office admin created it (Peter, 2026-07-30:
 * "Leanne was wrong"). Optimistic; reverts on error. Mirrors the lead
 * OwnerPicker (components/leads/owner-picker.tsx).
 */

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setQuoteEstimator } from "@/app/(dashboard)/quotes/actions";

// A sentinel value for the "no personal sender" option — Radix Select can't hold
// an empty string, so this maps to a null estimator (sends from Accounts).
const OFFICE = "__office__";

export function EstimatorPicker({
  quoteId,
  estimatorId,
  estimators,
}: {
  quoteId: string;
  estimatorId: string | null;
  estimators: { id: string; full_name: string }[];
}) {
  const router = useRouter();
  const triggerId = useId();
  const [value, setValue] = useState(estimatorId ?? OFFICE);
  const [pending, start] = useTransition();

  function onChange(next: string) {
    if (next === value) return;
    const prev = value;
    setValue(next);
    start(async () => {
      const res = await setQuoteEstimator(quoteId, next === OFFICE ? null : next);
      if (res.ok) {
        toast.success(next === OFFICE ? "Quote sends from Accounts" : "Quote assigned");
        router.refresh();
      } else {
        setValue(prev);
        toast.error(res.error || "Could not assign the quote.");
      }
    });
  }

  return (
    <div>
      <label htmlFor={triggerId} className="eyebrow mb-1.5 block">
        Sends from
      </label>
      <div className="flex items-center gap-2">
        {pending ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-mist-400" strokeWidth={1.75} />
        ) : null}
        <Select value={value} onValueChange={onChange} disabled={pending}>
          <SelectTrigger id={triggerId} className="w-full" aria-label="Quote email sender">
            <SelectValue placeholder="Office / Accounts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={OFFICE}>Office / Accounts (no personal sender)</SelectItem>
            {estimators.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
