"use client";

/**
 * Settings › Contractor invoicing (admin). Master switch for the crew invoicing
 * surface (/my-jobs "My pay"). OFF by default. Each contractor also signs the
 * contractor agreement once in their own portal before they can invoice (their
 * per-user gate); this switch is the global one. While off, the crew surface is
 * hidden and every invoice action rejects.
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
    toast.success(next ? "Contractor invoicing is on." : "Contractor invoicing is off.");
  }

  return (
    <Card className="p-0">
      <div className="flex items-center gap-3 border-b px-5 py-3.5">
        <HandCoins className="size-5 shrink-0 text-mm-red" strokeWidth={1.75} />
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Contractor invoicing</h2>
          <p className="mt-0.5 text-xs text-mist-400">
            Lets self-employed crew build + submit their own invoices (no VAT). Each contractor signs the contractor
            agreement once in their portal before they can invoice.
          </p>
        </div>
      </div>

      <div className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Crew contractor invoicing</p>
            <p className="text-xs text-mist-400">
              {enabled
                ? "Crew can build invoices from “My pay”. Submitted invoices show under Finance › Crew pay."
                : "Hidden from crew until switched on."}
            </p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => toggle(e.target.checked)}
            aria-label="Enable contractor invoicing"
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
