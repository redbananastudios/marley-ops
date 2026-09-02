"use client";

/**
 * Manual "Attach to quote" for bank transfers the matcher couldn't place.
 * Opens with everything the transfer's amount could pay (exact-amount open
 * deposits/commitments/balances); typing searches ALL open items by quote ref
 * or customer so a near-miss still shows up — un-attachable, with the amount
 * it actually wants. The server re-verifies the exact-amount invariant at
 * attach time, then runs the real paid pipeline (Zoho, chases, receipt).
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  attachBankTransactionAction,
  linkRecordedBankTransactionAction,
  recordCoveringPairAction,
  searchAttachTargetsAction,
  type AttachTarget,
} from "@/app/actions/bank-feed";

const gbp = (n: number): string =>
  "£" + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const KIND_LABEL: Record<AttachTarget["kind"], string> = {
  deposit: "Deposit",
  commitment: "Commitment",
  balance: "Balance",
  full: "Whole job",
  // The settle-in-full covering transfer: one payment for the OPEN commitment
  // + balance pair. Confirming records BOTH through the normal paid pipelines.
  pair: "Commitment + balance",
};

/** "Whole job (deposit + balance)" — the office must see WHICH payments a
 *  single transfer is about to settle, not just that it settles "everything". */
function targetLabel(t: AttachTarget): string {
  const base = KIND_LABEL[t.kind];
  return t.kind === "full" && t.kinds?.length ? `${base} (${t.kinds.join(" + ")})` : base;
}

export function AttachDialog({
  txId,
  amount,
  counterparty,
  reference,
}: {
  txId: string;
  amount: number;
  counterparty: string | null;
  reference: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<AttachTarget[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();

  // Debounced search; also fires on open with the empty query (the
  // "what could this amount be?" view). `targets === null` renders the
  // looking state until the first result set lands.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      start(async () => {
        const res = await searchAttachTargetsAction({ txId, query });
        if (res.ok) setTargets(res.targets);
        else toast.error(res.error ?? "Search failed.");
      });
    }, 250);
    return () => clearTimeout(t);
  }, [open, query, txId]);

  function attach(target: AttachTarget) {
    setBusyId(`${target.quoteId}:${target.kind}`);
    start(async () => {
      try {
        // Settled targets LINK (arrival-day truth, no pipeline); open targets
        // RECORD through the normal paid pipeline.
        // A whole-job target is ALWAYS a link: there is no open money to record,
        // only an already-recorded set to point this transfer at. A covering-
        // pair target is ALWAYS a record: both halves are open money, and the
        // server re-verifies the exact pair sum before recording either.
        // Narrowed explicitly so the attach path can never be handed either
        // pseudo-kind.
        const res =
          target.kind === "full"
            ? await linkRecordedBankTransactionAction({ txId, quoteId: target.quoteId, kind: "full" })
            : target.kind === "pair"
              ? await recordCoveringPairAction({ txId, quoteId: target.quoteId })
              : target.settled
                ? await linkRecordedBankTransactionAction({ txId, quoteId: target.quoteId, kind: target.kind })
                : await attachBankTransactionAction({ txId, quoteId: target.quoteId, kind: target.kind });
        if (!res.ok) {
          toast.error(res.error ?? "Could not record the payment.");
          router.refresh();
          return;
        }
        const what =
          target.kind === "full" || target.kind === "pair"
            ? (target.kinds ?? []).join(" + ")
            : target.kind;
        toast.success(
          target.settled
            ? `Linked — this transfer is ${target.quoteRef}'s ${what}, already recorded.`
            : `Recorded — ${target.quoteRef} ${what} marked paid (bank transfer).`,
        );
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not record the payment.");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setTargets(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-input bg-card px-2.5 text-sm text-mist-500 transition-colors hover:bg-muted"
        >
          <Link2 className="size-4" strokeWidth={1.75} />
          <span className="font-medium">Attach</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach to a quote</DialogTitle>
          <DialogDescription>
            {gbp(amount)} from {counterparty ?? "unknown payer"}
            {reference ? ` — “${reference}”` : ""}. Pick what it pays: open money is recorded through
            the normal pipeline (Zoho, chase closed, customer receipt); an already-recorded payment is
            linked so the ledger knows which day the money really arrived.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mist-400" strokeWidth={1.75} />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by quote ref or customer…"
            className="pl-9"
            autoFocus
          />
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {targets === null ? (
            <p className="px-1 py-4 text-sm text-mist-400">Looking for open payments…</p>
          ) : !targets.length ? (
            <p className="px-1 py-4 text-sm text-mist-400">
              {query
                ? "No open payments match that search."
                : `No open deposit, commitment or balance is exactly ${gbp(amount)} — search by ref or customer to check, or record it manually via Bookings/Zoho.`}
            </p>
          ) : (
            targets.map((t) => {
              const id = `${t.quoteId}:${t.kind}`;
              const busy = busyId === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => attach(t)}
                  disabled={!t.amountMatches || busyId !== null}
                  className="focus-ring flex w-full items-center gap-3 rounded-md border border-input bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {t.quoteRef}
                      {t.customer ? ` · ${t.customer}` : ""}
                    </p>
                    <p className="text-xs text-mist-400">
                      {targetLabel(t)}
                      {t.settled
                        ? " — already recorded, tap to link this transfer to it"
                        : t.kind === "pair"
                          ? " — one transfer settling both, tap to record both"
                          : t.amountMatches
                            ? " — tap to record"
                            : ` — ${gbp(t.amount)} due, amount differs`}
                    </p>
                  </div>
                  {busy ? (
                    <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} />
                  ) : (
                    <span className="tabular text-sm font-semibold text-foreground">{gbp(t.amount)}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
