"use client";

/**
 * Phase-1 payments — manual state on the lead. Requesting a deposit opens a chase
 * follow-up due tomorrow; marking paid closes it. Setting the balance opens a chase
 * due on its due date. No processing, no ledger — Zoho later.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PoundSterling } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  requestDepositAction,
  markPaymentPaidAction,
  setBalanceAction,
} from "@/app/(dashboard)/follow-ups/actions";
import { BalanceInvoiceButton } from "@/components/leads/balance-invoice-button";

export interface PaymentState {
  depositAmount: number | null;
  depositRequestedAt: string | null;
  depositPaidAt: string | null;
  balanceAmount: number | null;
  balanceDueDate: string | null;
  balancePaidAt: string | null;
}

const gbp = (n: number | null): string =>
  n != null ? "£" + Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : "—";

function fmt(d: string | null): string {
  if (!d) return "";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function PaymentsCard({
  leadId,
  state,
  defaultDeposit,
  agreedPrice,
}: {
  leadId: string;
  state: PaymentState;
  /** The standard deposit from Settings — prefill, editable per job. */
  defaultDeposit: number;
  /** Accepted quote value — suggested balance = agreed − deposit. */
  agreedPrice: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [deposit, setDeposit] = useState(String(state.depositAmount ?? (defaultDeposit || "")));
  const suggestedBalance =
    agreedPrice != null ? Math.max(0, agreedPrice - (state.depositAmount ?? (Number(deposit) || 0))) : null;
  const [balance, setBalance] = useState(String(state.balanceAmount ?? (suggestedBalance ?? "")));
  const [balanceDue, setBalanceDue] = useState(state.balanceDueDate ?? "");

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) toast.error(res.error || "Something went wrong.");
    else {
      toast.success(ok);
      router.refresh();
    }
  }

  return (
    <Card className="p-0">
      <div className="flex items-center gap-2 border-b px-5 py-3.5">
        <PoundSterling className="size-4 text-mist-400" strokeWidth={1.75} />
        <h2 className="font-display text-lg text-foreground">Payments</h2>
        {busy ? <Loader2 className="ml-auto size-4 animate-spin text-mist-400" strokeWidth={1.75} /> : null}
      </div>

      <div className="grid gap-5 p-5 sm:grid-cols-2">
        {/* Deposit */}
        <div>
          <p className="eyebrow mb-2">Deposit</p>
          {state.depositPaidAt ? (
            <p className="text-sm font-semibold text-success">
              {gbp(state.depositAmount)} paid {fmt(state.depositPaidAt)}
            </p>
          ) : state.depositRequestedAt ? (
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                {gbp(state.depositAmount)} requested {fmt(state.depositRequestedAt)}{" "}
                <span className="font-medium text-warn">· unpaid</span>
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => markPaymentPaidAction(leadId, "deposit"), "Deposit marked paid.")}>
                Mark deposit paid
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-28 items-center rounded-md border border-input bg-card px-2">
                <span className="mr-1 text-xs text-mist-400">£</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                  className="tabular h-full w-full bg-transparent text-sm focus:outline-none"
                  aria-label="Deposit amount"
                />
              </div>
              <Button
                size="sm"
                disabled={busy || !Number(deposit)}
                onClick={() => run(() => requestDepositAction(leadId, Number(deposit)), "Deposit requested — chase queued.")}
              >
                Request deposit
              </Button>
            </div>
          )}
        </div>

        {/* Balance */}
        <div>
          <p className="eyebrow mb-2">Balance</p>
          {state.balancePaidAt ? (
            <p className="text-sm font-semibold text-success">
              {gbp(state.balanceAmount)} paid {fmt(state.balancePaidAt)}
            </p>
          ) : state.balanceAmount != null && state.balanceDueDate ? (
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                {gbp(state.balanceAmount)} due {fmt(state.balanceDueDate)}{" "}
                <span className="font-medium text-warn">· unpaid</span>
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => markPaymentPaidAction(leadId, "balance"), "Balance marked paid.")}>
                Mark balance paid
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <BalanceInvoiceButton leadId={leadId} />
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex h-9 w-28 items-center rounded-md border border-input bg-card px-2">
                  <span className="mr-1 text-xs text-mist-400">£</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={balance}
                    onChange={(e) => setBalance(e.target.value)}
                    className="tabular h-full w-full bg-transparent text-sm focus:outline-none"
                    aria-label="Balance amount"
                  />
                </div>
                <Input type="date" value={balanceDue} onChange={(e) => setBalanceDue(e.target.value)} className="h-9 w-[150px]" aria-label="Balance due date" />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !Number(balance) || !balanceDue}
                  onClick={() => run(() => setBalanceAction(leadId, Number(balance), balanceDue), "Balance set — chase queued for the due date.")}
                >
                  Set manually
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
