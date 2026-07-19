"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { createMyEstimatorStatementAction } from "@/app/(dashboard)/estimator/pay/actions";

export function StartEstimatorStatement({
  periods,
}: {
  periods: { key: string; label: string; start: string; end: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function start(p: { key: string; start: string; end: string }) {
    setBusy(p.key);
    try {
      const r = await createMyEstimatorStatementAction({ period_start: p.start, period_end: p.end });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      router.push(`/estimator/pay/${r.id}`);
    } catch {
      toast.error("Couldn't reach the server — try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {periods.map((p) => (
        <button
          key={p.key}
          type="button"
          disabled={busy !== null}
          onClick={() => start(p)}
          className="focus-ring flex items-center gap-3 rounded-xl border border-input bg-card px-4 py-3.5 text-left hover:border-mm-red/40 disabled:opacity-60"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-mm-red/10 text-mm-red">
            {busy === p.key ? <Loader2 className="size-5 animate-spin" strokeWidth={1.75} /> : <Plus className="size-5" strokeWidth={1.75} />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-foreground">Start an invoice</span>
            <span className="block text-xs text-mist-400">{p.label}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
