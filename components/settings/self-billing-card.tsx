"use client";

/**
 * Settings › Self-billing (admin). Master switch for the crew payment-statement
 * surface (/my-jobs "My pay"). OFF by default — turn it on only once the signed
 * self-billing agreement is in place (the go-live gate). While off, the crew
 * surface is hidden and every pay action rejects.
 */

import { useState } from "react";
import { HandCoins, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { setSelfBillingEnabledAction } from "@/app/(dashboard)/settings/actions";

export function SelfBillingCard({ enabled: initial }: { enabled: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function toggle(next: boolean) {
    setEnabled(next); // optimistic
    setBusy(true);
    const res = await setSelfBillingEnabledAction(next);
    setBusy(false);
    if (!res.ok) {
      setEnabled(!next);
      toast.error(res.error);
      return;
    }
    toast.success(next ? "Self-billing is on." : "Self-billing is off.");
  }

  return (
    <Card className="p-0">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <HandCoins className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Self-billing</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Lets crew build + submit their own payment statements (no VAT). Turn on once the self-billing agreement is
            signed.
          </p>
        </div>
      </div>

      <div className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Crew self-billing</p>
            <p className="text-xs text-mist-400">
              {enabled
                ? "Crew can build statements from “My pay”. Submitted statements show under Finance › Crew pay."
                : "Hidden from crew until switched on."}
            </p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => toggle(e.target.checked)}
            aria-label="Enable crew self-billing"
            className="size-6 shrink-0 accent-mm-red disabled:opacity-50"
          />
        </div>
        {busy ? (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-mist-400">
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2} /> Saving…
          </p>
        ) : null}
      </div>
    </Card>
  );
}
