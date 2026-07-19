"use client";

/**
 * Card-payment ledger on the lead — one row per takepayments attempt, with an
 * admin-only Refund (or same-day void) on a paid row. Read-only for estimators;
 * the card exists for anyone once an attempt has been made.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { refundCardPaymentAction } from "@/app/actions/card-payments";

export interface CardPaymentRow {
  id: string;
  status: string;
  amountPence: number;
  refundedPence: number;
  cardNumberMask: string | null;
  cardScheme: string | null;
  createdAt: string;
  settledAt: string | null;
  refundReason: string | null;
}

const gbpP = (p: number): string => "£" + (p / 100).toFixed(2);

function when(d: string | null): string {
  if (!d) return "";
  const t = new Date(d);
  return Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "Awaiting", cls: "bg-mist-100 text-mist-500" },
  paid: { label: "Paid", cls: "bg-success/10 text-success" },
  failed: { label: "Declined", cls: "bg-warn-bg text-warn" },
  abandoned: { label: "Not completed", cls: "bg-mist-100 text-mist-400" },
  refunded: { label: "Refunded", cls: "bg-mist-100 text-mist-500" },
  partially_refunded: { label: "Part-refunded", cls: "bg-mist-100 text-mist-500" },
  voided: { label: "Voided", cls: "bg-mist-100 text-mist-500" },
  needs_review: { label: "Needs review", cls: "bg-warn-bg text-warn" },
};

export function CardPaymentsCard({ rows, isAdmin }: { rows: CardPaymentRow[]; isAdmin: boolean }) {
  if (!rows.length) return null;
  return (
    <Card className="p-0">
      <div className="flex items-center gap-2 border-b px-5 py-3.5">
        <CreditCard className="size-4 text-mist-400" strokeWidth={1.75} />
        <h2 className="font-display text-lg text-foreground">Card payments</h2>
      </div>
      <ul className="divide-y">
        {rows.map((r) => (
          <CardRow key={r.id} row={r} isAdmin={isAdmin} />
        ))}
      </ul>
    </Card>
  );
}

function CardRow({ row, isAdmin }: { row: CardPaymentRow; isAdmin: boolean }) {
  const badge = STATUS[row.status] ?? { label: row.status, cls: "bg-mist-100 text-mist-500" };
  const remaining = row.amountPence - row.refundedPence;
  const canRefund = isAdmin && ["paid", "partially_refunded"].includes(row.status) && remaining > 0;
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">
          {gbpP(row.amountPence)}
          {row.cardNumberMask ? (
            <span className="ml-2 font-normal text-mist-400">
              {row.cardScheme ? `${row.cardScheme} ` : ""}•••• {row.cardNumberMask.slice(-4)}
            </span>
          ) : null}
        </p>
        <p className="text-xs text-mist-400">
          {when(row.settledAt ?? row.createdAt)}
          {row.refundedPence > 0 ? ` · ${gbpP(row.refundedPence)} refunded` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
          {badge.label}
        </span>
        {canRefund ? <RefundDialog row={row} remaining={remaining} /> : null}
      </div>
    </li>
  );
}

function RefundDialog({ row, remaining }: { row: CardPaymentRow; remaining: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  // The server action has an atomic reserve, but the UI must not invite a
  // second click either: everything stays locked from the moment Refund is
  // pressed until the refreshed server state (new status/remaining) renders.
  const processing = busy || refreshing;

  async function submit() {
    const pence = Math.round(Number(amount) * 100);
    if (!Number.isInteger(pence) || pence <= 0 || pence > remaining) {
      toast.error(`Enter an amount up to ${gbpP(remaining)}.`);
      return;
    }
    if (!reason.trim()) {
      toast.error("A reason is required.");
      return;
    }
    setBusy(true);
    // try/finally: a rejected action (network drop / stale action id after a
    // deploy) must clear busy — otherwise the onOpenChange close-guard traps the
    // dialog spinning with no way out but a reload, on a screen that moves money.
    try {
      const res = await refundCardPaymentAction({ paymentId: row.id, amountPence: pence, reason: reason.trim() });
      if (!res.ok) {
        toast.error(res.error || "Refund failed.");
        return;
      }
      toast.success("Refund sent — the customer's card will show it in 3–5 working days.");
      setOpen(false);
      startRefresh(() => router.refresh());
    } catch {
      toast.error("Couldn't reach the payment service — check the payment status before retrying.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // No escape hatch mid-refund — closing (Esc/overlay) while the gateway
        // call is in flight would leave the admin unsure whether money moved.
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={processing}>
          {refreshing ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : "Refund"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Refund card deposit</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block">
            <span className="eyebrow mb-1.5 block">Amount</span>
            <div className="flex h-10 w-40 items-center rounded-md border border-input bg-card px-2">
              <span className="mr-1 text-sm text-mist-400">£</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                max={(remaining / 100).toFixed(2)}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tabular h-full w-full bg-transparent text-sm focus:outline-none"
                aria-label="Refund amount"
              />
            </div>
            <span className="mt-1 block text-xs text-mist-400">Up to {gbpP(remaining)} (partial allowed)</span>
          </label>
          <label className="block">
            <span className="eyebrow mb-1.5 block">Reason</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Booking cancelled — full refund agreed"
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mm-red/40"
            />
          </label>
          <p className="rounded-md bg-warn-bg px-3 py-2 text-xs leading-relaxed text-warn">
            Goes back to the customer&apos;s original card
            {row.cardNumberMask ? ` (•••• ${row.cardNumberMask.slice(-4)})` : ""}, normally within
            3–5 working days. This can&apos;t be undone.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={processing} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {processing ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" strokeWidth={2} /> Refunding…
              </span>
            ) : (
              `Refund £${amount}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
