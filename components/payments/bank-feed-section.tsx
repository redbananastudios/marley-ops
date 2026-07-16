"use client";

/**
 * Bank feed on /payments — the Monzo transactions the 2-minute sync has
 * ingested. Two surfaces:
 *   1. Suggested matches (ANY date): inbound transfers the matcher tied to an
 *      open deposit/balance — Confirm runs the real paid pipeline; Dismiss
 *      removes a false positive. This is where the reconciliation backlog
 *      surfaces, so it isn't limited to the viewed day.
 *   2. The viewed day's inbound bank activity, with status chips.
 * Money is never auto-marked: every recorded payment passed a human tap here.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Landmark, Loader2, X } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import {
  confirmBankTransactionAction,
  dismissBankTransactionAction,
} from "@/app/actions/bank-feed";

export interface BankFeedTx {
  id: string;
  txDate: string;
  txTime: string | null;
  counterparty: string | null;
  amount: number;
  reference: string | null;
  status: string;
  matchKind: string | null;
  matchConfidence: string | null;
  quoteRef: string | null;
  quoteCustomer: string | null;
  leadId: string | null;
}

const gbp = (n: number): string =>
  "£" + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  suggested: { label: "Match found", cls: "bg-warn-bg text-warn" },
  confirmed: { label: "Recorded", cls: "bg-success-bg text-success" },
  unmatched: { label: "Unmatched", cls: "bg-mist-100 text-mist-500" },
  dismissed: { label: "Dismissed", cls: "bg-mist-100 text-mist-400" },
};

function SuggestedRow({ tx }: { tx: BankFeedTx }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"confirm" | "dismiss" | null>(null);
  const [, start] = useTransition();

  function run(kind: "confirm" | "dismiss") {
    setBusy(kind);
    start(async () => {
      try {
        const res =
          kind === "confirm"
            ? await confirmBankTransactionAction(tx.id)
            : await dismissBankTransactionAction(tx.id);
        if (!res.ok) {
          toast.error(res.error ?? "Could not update the transaction.");
          return;
        }
        toast.success(
          kind === "confirm"
            ? `Recorded — ${tx.quoteRef ?? "payment"} marked paid (bank transfer).`
            : "Dismissed.",
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not update the transaction.");
      } finally {
        setBusy(null);
      }
    });
  }

  const storage = tx.matchKind === "storage";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <span className="tabular w-14 shrink-0 text-xs text-mist-400">{fmtDay(tx.txDate)}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {tx.counterparty ?? "—"}
          <span className="ml-2 text-xs font-normal text-mist-400">“{tx.reference ?? "no reference"}”</span>
        </p>
        <p className="text-xs text-mist-400">
          {storage ? (
            <>storage payment — record it from the Storage page</>
          ) : (
            <>
              looks like the <span className="font-semibold">{tx.matchKind}</span> for{" "}
              {tx.leadId ? (
                <Link href={`/leads/${tx.leadId}`} className="font-semibold text-foreground hover:underline">
                  {tx.quoteRef} · {tx.quoteCustomer ?? "—"}
                </Link>
              ) : (
                <span className="font-semibold">{tx.quoteRef}</span>
              )}
              {tx.matchConfidence === "amount" ? " (matched by amount only — check before confirming)" : null}
            </>
          )}
        </p>
      </div>
      <span className="tabular text-sm font-semibold text-foreground">{gbp(tx.amount)}</span>
      {!storage ? (
        <button
          type="button"
          onClick={() => run("confirm")}
          disabled={busy !== null}
          className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3 text-sm font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60"
        >
          {busy === "confirm" ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={2} />
          ) : (
            <Check className="size-4" strokeWidth={2} />
          )}
          Confirm — mark paid
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => run("dismiss")}
        disabled={busy !== null}
        aria-label="Dismiss"
        className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-card px-2.5 text-sm text-mist-500 transition-colors hover:bg-muted disabled:opacity-60"
      >
        {busy === "dismiss" ? (
          <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
        ) : (
          <X className="size-4" strokeWidth={1.75} />
        )}
      </button>
    </div>
  );
}

export function BankFeedSection({
  suggested,
  dayRows,
  dayLabelText,
  lastSync,
  unmatchedCount,
}: {
  suggested: BankFeedTx[];
  dayRows: BankFeedTx[];
  dayLabelText: string;
  /** "3 min ago · ok" style line, or null if the cron has never run. */
  lastSync: string | null;
  unmatchedCount: number;
}) {
  return (
    <>
      {suggested.length ? (
        <Card className="p-0">
          <div className="flex items-center gap-2 border-b px-5 py-3.5">
            <Landmark className="size-4 text-mist-400" strokeWidth={1.75} />
            <h2 className="font-display text-lg font-semibold text-foreground">
              Bank transfers to confirm
            </h2>
            <span className="ml-auto inline-flex min-w-6 items-center justify-center rounded-pill bg-warn-bg px-2 py-0.5 text-xs font-bold tabular text-warn">
              {suggested.length}
            </span>
          </div>
          <div className="divide-y">
            {suggested.map((tx) => (
              <SuggestedRow key={tx.id} tx={tx} />
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3.5">
          <Landmark className="size-4 text-mist-400" strokeWidth={1.75} />
          <h2 className="font-display text-lg font-semibold text-foreground">Bank feed</h2>
          <span className="text-xs text-mist-400">
            {lastSync ? `synced ${lastSync}` : "waiting for the first sync"}
            {unmatchedCount ? ` · ${unmatchedCount} unmatched inbound to review` : ""}
          </span>
          <span className="ml-auto inline-flex min-w-6 items-center justify-center rounded-pill bg-muted px-2 py-0.5 text-xs font-semibold tabular text-mist-500">
            {dayRows.length}
          </span>
        </div>
        {dayRows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">
            No inbound bank transfers {dayLabelText}.
          </p>
        ) : (
          <div className="divide-y">
            {dayRows.map((tx) => {
              const chip = STATUS_CHIP[tx.status] ?? { label: tx.status, cls: "bg-mist-100 text-mist-500" };
              return (
                <div key={tx.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                  <span className="tabular w-12 shrink-0 text-xs text-mist-400">
                    {tx.txTime?.slice(0, 5) ?? "—"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{tx.counterparty ?? "—"}</p>
                    <p className="truncate text-xs text-mist-400">“{tx.reference ?? "no reference"}”</p>
                  </div>
                  <span className={`rounded-pill px-2.5 py-0.5 text-[11px] font-semibold ${chip.cls}`}>
                    {chip.label}
                  </span>
                  <span className="tabular text-sm font-semibold text-foreground">{gbp(tx.amount)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
