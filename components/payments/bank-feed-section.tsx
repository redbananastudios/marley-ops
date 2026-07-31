"use client";

/**
 * Bank feed on /payments — the Monzo transactions the 2-minute sync has
 * ingested. Three surfaces:
 *   1. Suggested matches (ANY date): inbound transfers tied to an open
 *      deposit/balance at the EXACT amount — Confirm runs the real paid
 *      pipeline (bound to the precise quote+kind shown here; if the matcher
 *      re-pointed the row meanwhile, the server refuses and asks for a
 *      refresh). Dismiss removes a false positive.
 *   2. Amount mismatches: a transfer that NAMES an open quote but doesn't
 *      match its amount (part-payment / overpayment / duplicate) — flagged
 *      for manual recording, deliberately not confirmable.
 *   3. The viewed day's inbound bank activity, with status chips.
 * Money is never auto-marked: every recorded payment passed a human tap here.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Landmark, Loader2, X } from "lucide-react";
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
  quoteId: string | null;
  quoteRef: string | null;
  quoteCustomer: string | null;
  leadId: string | null;
  /** The open item's amount (for mismatch rows: what the quote actually wants). */
  expectedAmount: number | null;
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

function DismissButton({
  txId,
  busyExternal,
  label,
}: {
  txId: string;
  busyExternal?: boolean;
  /** When set, renders a text button (e.g. "Clear") instead of an icon-only one. */
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => {
        setBusy(true);
        start(async () => {
          try {
            const res = await dismissBankTransactionAction(txId);
            if (!res.ok) toast.error(res.error ?? "Could not dismiss.");
            else router.refresh();
          } finally {
            setBusy(false);
          }
        });
      }}
      disabled={busy || busyExternal}
      aria-label={label ?? "Dismiss"}
      className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-card px-2.5 text-sm text-mist-500 transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <X className="size-4" strokeWidth={1.75} />}
      {label ? <span className="font-medium">{label}</span> : null}
    </button>
  );
}

function SuggestedRow({ tx }: { tx: BankFeedTx }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  const storage = tx.matchKind === "storage";
  const confirmable = !storage && tx.quoteId && (tx.matchKind === "deposit" || tx.matchKind === "balance");

  function confirm() {
    if (!confirmable || !tx.quoteId) return;
    setBusy(true);
    start(async () => {
      try {
        const res = await confirmBankTransactionAction({
          txId: tx.id,
          expectedQuoteId: tx.quoteId!,
          expectedKind: tx.matchKind as "deposit" | "balance",
        });
        if (!res.ok) {
          toast.error(res.error ?? "Could not record the payment.");
          router.refresh(); // the suggestion may have changed — show the truth
          return;
        }
        toast.success(`Recorded — ${tx.quoteRef ?? "payment"} ${tx.matchKind} marked paid (bank transfer).`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not record the payment.");
      } finally {
        setBusy(false);
      }
    });
  }

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
              the <span className="font-semibold">{tx.matchKind}</span> for{" "}
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
      {confirmable ? (
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3 text-sm font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={2} />
          ) : (
            <Check className="size-4" strokeWidth={2} />
          )}
          Confirm — mark paid
        </button>
      ) : null}
      <DismissButton txId={tx.id} busyExternal={busy} />
    </div>
  );
}

function MismatchRow({ tx }: { tx: BankFeedTx }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <span className="tabular w-14 shrink-0 text-xs text-mist-400">{fmtDay(tx.txDate)}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {tx.counterparty ?? "—"}
          <span className="ml-2 text-xs font-normal text-mist-400">“{tx.reference ?? "no reference"}”</span>
        </p>
        <p className="text-xs text-warn">
          references{" "}
          {tx.leadId ? (
            <Link href={`/leads/${tx.leadId}`} className="font-semibold hover:underline">
              {tx.quoteRef}
            </Link>
          ) : (
            <span className="font-semibold">{tx.quoteRef}</span>
          )}{" "}
          but the open {tx.matchKind} is {tx.expectedAmount != null ? gbp(tx.expectedAmount) : "a different amount"} —
          part-payment or duplicate. Record it manually via Bookings/Zoho, then dismiss.
        </p>
      </div>
      <span className="tabular text-sm font-semibold text-warn">{gbp(tx.amount)}</span>
      <DismissButton txId={tx.id} />
    </div>
  );
}

/** Plain unmatched inbound (all dates): money we couldn't tie to any open
 *  deposit/balance and that doesn't name a quote — old-system transfers,
 *  non-customer credits, or a payment still to be recorded by hand. Clearing
 *  dismisses the row (the sync preserves dismissed rows, so it stays gone). */
function UnmatchedRow({ tx }: { tx: BankFeedTx }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <span className="tabular w-14 shrink-0 text-xs text-mist-400">{fmtDay(tx.txDate)}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {tx.counterparty ?? "—"}
          <span className="ml-2 text-xs font-normal text-mist-400">“{tx.reference ?? "no reference"}”</span>
        </p>
        <p className="text-xs text-mist-400">
          no matching open deposit or balance — record it via Bookings/Zoho if it&apos;s a customer payment,
          otherwise clear it.
        </p>
      </div>
      <span className="tabular text-sm font-semibold text-foreground">{gbp(tx.amount)}</span>
      <DismissButton txId={tx.id} label="Clear" />
    </div>
  );
}

export function BankFeedSection({
  suggested,
  mismatches,
  dayRows,
  unmatched,
  dayLabelText,
  lastSync,
}: {
  suggested: BankFeedTx[];
  mismatches: BankFeedTx[];
  dayRows: BankFeedTx[];
  /** All-dates plain unmatched inbound (no quote match) — clearable review queue. */
  unmatched: BankFeedTx[];
  dayLabelText: string;
  /** "3 min ago · ok" style line, or null if the cron has never run. */
  lastSync: string | null;
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

      {mismatches.length ? (
        <Card className="p-0">
          <div className="flex items-center gap-2 border-b px-5 py-3.5">
            <AlertTriangle className="size-4 text-warn" strokeWidth={1.75} />
            <h2 className="font-display text-lg font-semibold text-foreground">
              Transfers that need a human
            </h2>
            <span className="ml-auto inline-flex min-w-6 items-center justify-center rounded-pill bg-warn-bg px-2 py-0.5 text-xs font-bold tabular text-warn">
              {mismatches.length}
            </span>
          </div>
          <div className="divide-y">
            {mismatches.map((tx) => (
              <MismatchRow key={tx.id} tx={tx} />
            ))}
          </div>
        </Card>
      ) : null}

      {unmatched.length ? (
        <Card className="p-0">
          <div className="flex items-center gap-2 border-b px-5 py-3.5">
            <Landmark className="size-4 text-mist-400" strokeWidth={1.75} />
            <h2 className="font-display text-lg font-semibold text-foreground">
              Unmatched inbound
            </h2>
            <span className="ml-auto inline-flex min-w-6 items-center justify-center rounded-pill bg-muted px-2 py-0.5 text-xs font-bold tabular text-mist-500">
              {unmatched.length}
            </span>
          </div>
          <p className="border-b px-5 py-2.5 text-xs text-mist-400">
            Inbound transfers across all dates that don&apos;t match an open deposit or balance. Record real
            customer payments via Bookings/Zoho, then clear them; clear anything that isn&apos;t a customer
            payment to take it off this list.
          </p>
          <div className="divide-y">
            {unmatched.map((tx) => (
              <UnmatchedRow key={tx.id} tx={tx} />
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
              const mismatch = tx.status === "unmatched" && tx.quoteRef;
              const chip = mismatch
                ? { label: "Amount differs — needs a human", cls: "bg-warn-bg text-warn" }
                : (STATUS_CHIP[tx.status] ?? { label: tx.status, cls: "bg-mist-100 text-mist-500" });
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
