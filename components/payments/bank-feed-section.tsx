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
import { AlertTriangle, Check, Landmark, Link2, Loader2, Undo2, X } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import {
  confirmBankTransactionAction,
  dismissBankTransactionAction,
  linkRecordedBankTransactionAction,
  recordCoveringPairAction,
  unlinkBankTransactionAction,
} from "@/app/actions/bank-feed";
import { AttachDialog } from "@/components/payments/attach-dialog";

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
  /** Acquirer payout (Elavon/takepayments) — already recorded at card-payment
   * time, shown in the day feed for visibility but never actionable. */
  isSettlement: boolean;
  /** This transfer looks like a payment ALREADY on the books (exact amount +
   * payer/reference name matches the customer) — one tap links it (status
   * reconciled, arrival-day truth); the paid pipeline never runs. */
  settledHint?: {
    quoteId: string;
    quoteRef: string;
    customer: string | null;
    kind: "deposit" | "commitment" | "balance";
    leadId: string | null;
  } | null;
  /** This transfer equals, to the penny, the sum of its named quote's OPEN
   * commitment + balance — the settle-in-full covering transfer (gate 9c).
   * One tap records BOTH payments through the normal paid pipelines; nothing
   * is automatic, and off-by-a-penny or ambiguity renders no hint at all. */
  coveringPairHint?: {
    commitmentAmount: number;
    balanceAmount: number;
  } | null;
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
  // Payment was already recorded via Zoho / a manual mark-paid before the bank
  // row was processed — linked automatically, nothing to action.
  reconciled: { label: "Matched to recorded payment", cls: "bg-success-bg text-success" },
  unmatched: { label: "Unmatched", cls: "bg-mist-100 text-mist-500" },
  dismissed: { label: "Dismissed", cls: "bg-mist-100 text-mist-400" },
};

/** Count badge that tells the truth when the list is capped: "12" when we hold
 *  them all, "50 of 63" when we don't. A badge showing the cap made a truncated
 *  queue look complete — on the page whose job is proving nothing is missed. */
function CountBadge({ shown, total, tone }: { shown: number; total: number | null; tone: "warn" | "muted" }) {
  const capped = total != null && total > shown;
  const cls =
    tone === "warn"
      ? "bg-warn-bg text-warn"
      : "bg-muted text-mist-500";
  return (
    <span className={`ml-auto inline-flex min-w-6 items-center justify-center rounded-pill px-2 py-0.5 text-xs font-bold tabular ${cls}`}>
      {capped ? `${shown} of ${total}` : (total ?? shown)}
    </span>
  );
}

function DismissButton({
  txId,
  busyExternal,
  label,
  /** Shown in the confirmation prompt so a mis-tap on four figures is caught. */
  confirmWith,
}: {
  txId: string;
  busyExternal?: boolean;
  /** When set, renders a text button (e.g. "Clear") instead of an icon-only one. */
  label?: string;
  confirmWith?: { amount: number; counterparty: string | null };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  return (
    <button
      type="button"
      onClick={() => {
        // Clearing is irreversible — a cleared row leaves every queue, drops
        // out of the "not recorded yet" total and nothing brings it back. On a
        // list where four-figure transfers sit one tap from "Clear", that is
        // worth a sentence naming the money first.
        if (
          confirmWith &&
          !window.confirm(
            `Clear ${gbp(confirmWith.amount)} from ${confirmWith.counterparty ?? "unknown payer"}?\n\n` +
              `Only do this if it is NOT a customer payment. It leaves the queue for good and stops counting as money still to explain.`,
          )
        ) {
          return;
        }
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

/** Undo a link — puts a reconciled row back in front of the office. */
function UnlinkButton({ txId }: { txId: string }) {
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
            const res = await unlinkBankTransactionAction(txId);
            if (!res.ok) toast.error(res.error ?? "Could not unlink.");
            else {
              toast.success("Unlinked — the transfer is back in Unmatched inbound.");
              router.refresh();
            }
          } finally {
            setBusy(false);
          }
        });
      }}
      disabled={busy}
      className="focus-ring inline-flex min-h-8 items-center gap-1 rounded-md border border-input bg-card px-2 text-xs font-medium text-mist-500 transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} /> : <Undo2 className="size-3.5" strokeWidth={1.75} />}
      Unlink
    </button>
  );
}

function SuggestedRow({ tx }: { tx: BankFeedTx }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  const storage = tx.matchKind === "storage";
  const confirmable =
    !storage &&
    tx.quoteId &&
    (tx.matchKind === "deposit" || tx.matchKind === "commitment" || tx.matchKind === "balance");

  function confirm() {
    if (!confirmable || !tx.quoteId) return;
    setBusy(true);
    start(async () => {
      try {
        const res = await confirmBankTransactionAction({
          txId: tx.id,
          expectedQuoteId: tx.quoteId!,
          expectedKind: tx.matchKind as "deposit" | "commitment" | "balance",
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
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  // A transfer for a payment that ALREADY has a bank row against it: the
  // customer has most likely paid twice, so this is money we owe back rather
  // than money to explain away. It is deliberately parked here instead of
  // being auto-reconciled, which would have hidden it on every surface.
  const duplicate = tx.matchConfidence === "duplicate";
  // The settle-in-full covering transfer: equals the quote's open commitment +
  // balance to the penny. One tap records both; the server re-verifies the
  // exact sum against fresh open items before any money moves.
  const pair = !duplicate ? tx.coveringPairHint ?? null : null;
  const quoteLink = tx.leadId ? (
    <Link href={`/leads/${tx.leadId}`} className="font-semibold hover:underline">
      {tx.quoteRef}
    </Link>
  ) : (
    <span className="font-semibold">{tx.quoteRef}</span>
  );

  function confirmPair() {
    if (!pair || !tx.quoteId) return;
    setBusy(true);
    start(async () => {
      try {
        const res = await recordCoveringPairAction({ txId: tx.id, quoteId: tx.quoteId! });
        if (!res.ok) {
          toast.error(res.error ?? "Could not record the payments.");
          router.refresh(); // the pair may have changed — show the truth
          return;
        }
        toast.success(
          `Recorded — ${tx.quoteRef ?? "quote"} commitment + balance marked paid (bank transfer).`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not record the payments.");
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
        {duplicate ? (
          <p className="text-xs text-warn">
            <span className="font-semibold">Possible double payment.</span> {quoteLink}&apos;s {tx.matchKind} is
            already recorded and already has a transfer against it, so this looks like a second one. Check
            the bank, then refund or credit the customer before clearing this row.
          </p>
        ) : pair ? (
          <p className="text-xs text-mist-400">
            covers {quoteLink}&apos;s open commitment ({gbp(pair.commitmentAmount)}) + balance (
            {gbp(pair.balanceAmount)}) exactly — the customer settled in full with one transfer. Confirm
            to record both payments.
          </p>
        ) : (
          <p className="text-xs text-warn">
            references {quoteLink} but the open {tx.matchKind} is{" "}
            {tx.expectedAmount != null ? gbp(tx.expectedAmount) : "a different amount"} — part-payment or
            duplicate. Record it manually via Bookings/Zoho, then dismiss — or attach it if it actually
            pays a different quote.
          </p>
        )}
      </div>
      <span className={`tabular text-sm font-semibold ${pair ? "text-foreground" : "text-warn"}`}>
        {gbp(tx.amount)}
      </span>
      {pair && tx.quoteId ? (
        <button
          type="button"
          onClick={confirmPair}
          disabled={busy}
          className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3 text-sm font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={2} />
          ) : (
            <Check className="size-4" strokeWidth={2} />
          )}
          Confirm — record both
        </button>
      ) : null}
      <AttachDialog txId={tx.id} amount={tx.amount} counterparty={tx.counterparty} reference={tx.reference} />
      <DismissButton
        txId={tx.id}
        busyExternal={busy}
        confirmWith={{ amount: tx.amount, counterparty: tx.counterparty }}
      />
    </div>
  );
}

/** Plain unmatched inbound (all dates): money we couldn't tie to any open
 *  deposit/balance and that doesn't name a quote — old-system transfers,
 *  non-customer credits, or a payment still to be recorded by hand. When the
 *  amount + payer name point at exactly one ALREADY-RECORDED payment, the row
 *  says so and offers a one-tap Link (reconcile — no paid pipeline) instead of
 *  pretending the money is a mystery. Clearing dismisses the row (the sync
 *  preserves dismissed rows, so it stays gone). */
function UnmatchedRow({ tx }: { tx: BankFeedTx }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, start] = useTransition();
  const hint = tx.settledHint ?? null;

  function link() {
    if (!hint) return;
    setBusy(true);
    start(async () => {
      try {
        const res = await linkRecordedBankTransactionAction({
          txId: tx.id,
          quoteId: hint.quoteId,
          kind: hint.kind,
        });
        if (!res.ok) {
          toast.error(res.error ?? "Could not link the transfer.");
          router.refresh();
          return;
        }
        toast.success(`Linked — this transfer is ${hint.quoteRef}'s ${hint.kind}, already recorded.`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not link the transfer.");
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
        {hint ? (
          <p className="text-xs text-mist-400">
            looks like the <span className="font-semibold">{hint.kind}</span> for{" "}
            {hint.leadId ? (
              <Link href={`/leads/${hint.leadId}`} className="font-semibold text-foreground hover:underline">
                {hint.quoteRef} · {hint.customer ?? "—"}
              </Link>
            ) : (
              <span className="font-semibold">
                {hint.quoteRef}
                {hint.customer ? ` · ${hint.customer}` : ""}
              </span>
            )}
            , which is already recorded (same amount, same name) — link it so the ledger knows the day
            this money really arrived.
          </p>
        ) : (
          <p className="text-xs text-mist-400">
            no matching open payment — attach it to the right quote if it&apos;s a customer payment,
            otherwise clear it.
          </p>
        )}
      </div>
      <span className="tabular text-sm font-semibold text-foreground">{gbp(tx.amount)}</span>
      {hint ? (
        <button
          type="button"
          onClick={link}
          disabled={busy}
          className="focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md bg-mm-red px-3 text-sm font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={2} />
          ) : (
            <Link2 className="size-4" strokeWidth={2} />
          )}
          Link — already recorded
        </button>
      ) : null}
      {/* Always reachable: the hint is a guess, so the office must still be able
          to point the transfer somewhere else without clearing it first. */}
      <AttachDialog txId={tx.id} amount={tx.amount} counterparty={tx.counterparty} reference={tx.reference} />
      <DismissButton
        txId={tx.id}
        label="Clear"
        busyExternal={busy}
        confirmWith={{ amount: tx.amount, counterparty: tx.counterparty }}
      />
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
  totals,
  readFailed,
}: {
  suggested: BankFeedTx[];
  mismatches: BankFeedTx[];
  dayRows: BankFeedTx[];
  /** All-dates plain unmatched inbound (no quote match) — clearable review queue. */
  unmatched: BankFeedTx[];
  dayLabelText: string;
  /** "3 min ago · ok" style line, or null if the cron has never run. */
  lastSync: string | null;
  /** True queue sizes behind the capped lists. */
  totals?: { suggested: number | null; mismatches: number | null; unmatched: number | null; feed: number | null };
  /** A queue read failed — an empty list below may be a lie, so say so. */
  readFailed?: boolean;
}) {
  return (
    <>
      {readFailed ? (
        <Card className="flex items-center gap-2.5 border-warn/30 bg-warn-bg/40 px-5 py-3">
          <AlertTriangle className="size-4 shrink-0 text-warn" strokeWidth={2} />
          <p className="text-sm font-medium text-foreground">
            Some bank queues couldn&apos;t be loaded — what&apos;s below may be incomplete. Reload before
            treating this as up to date.
          </p>
        </Card>
      ) : null}

      {suggested.length ? (
        <Card className="p-0">
          <div className="flex items-center gap-2 border-b px-5 py-3.5">
            <Landmark className="size-4 text-mist-400" strokeWidth={1.75} />
            <h2 className="font-display text-lg font-semibold text-foreground">
              Bank transfers to confirm
            </h2>
            <CountBadge shown={suggested.length} total={totals?.suggested ?? null} tone="warn" />
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
            <CountBadge shown={mismatches.length} total={totals?.mismatches ?? null} tone="warn" />
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
            <CountBadge shown={unmatched.length} total={totals?.unmatched ?? null} tone="muted" />
          </div>
          <p className="border-b px-5 py-2.5 text-xs text-mist-400">
            Inbound transfers across all dates that don&apos;t match an open deposit, commitment or balance.
            Attach real customer payments to their quote to record them; where a row already matches a
            payment on the books, link it so the ledger dates the money to the day it arrived; clear
            anything that isn&apos;t a customer payment to take it off this list.
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
          <CountBadge shown={dayRows.length} total={totals?.feed ?? null} tone="muted" />
        </div>
        {dayRows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-mist-400">
            No inbound bank transfers {dayLabelText}.
          </p>
        ) : (
          <div className="divide-y">
            {dayRows.map((tx) => {
              const mismatch = tx.status === "unmatched" && tx.quoteRef;
              // A card settlement is Elavon paying out card takings — recorded
              // when the card was charged, so it must never read as actionable.
              const chip = tx.isSettlement
                ? { label: "Card settlement — already recorded", cls: "bg-mist-100 text-mist-500" }
                : mismatch
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
                  {/* A linked row is otherwise locked — the sync never revisits
                      it and no other action accepts it — so without this a
                      mis-tapped link needed database surgery to undo. */}
                  {tx.status === "reconciled" ? <UnlinkButton txId={tx.id} /> : null}
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
