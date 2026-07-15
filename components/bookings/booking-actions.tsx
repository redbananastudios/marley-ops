"use client";

/**
 * Bookings-row client actions: mark deposit/balance paid (with the how — bank
 * transfer or cash — so Zoho records the right payment mode) and copy the
 * customer's accept/payment link.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Banknote, Check, Landmark, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  markQuoteBalancePaidAction,
  markQuoteDepositPaidAction,
} from "@/app/(dashboard)/bookings/actions";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function MarkPaidButton({
  quoteId,
  kind,
  amount,
  customerName,
  leadId,
  moveDay,
}: {
  quoteId: string;
  kind: "deposit" | "balance";
  amount: number;
  customerName: string | null;
  /** Lead behind the quote — powers the deposit toast's next-step action. */
  leadId?: string;
  /** UK calendar day (YYYY-MM-DD) of the removal appointment, or null when it
   *  isn't in the diary yet. MUST be the Europe/London day, not the UTC date —
   *  the Job Board buckets by UK day, and an all-day Monday move during BST is
   *  stored 23:00Z Sunday, so slicing the raw timestamptz would deep-link to
   *  the previous week. Decides whether the deposit toast offers "Assign crew"
   *  (Job Board at the move's week) or "Book removal" (removals diary). */
  moveDay?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function pay(method: "bank_transfer" | "cash") {
    start(async () => {
      const res =
        kind === "deposit"
          ? await markQuoteDepositPaidAction(quoteId, method)
          : await markQuoteBalancePaidAction(quoteId, method);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // A paid deposit is the moment a job becomes real — surface the next
      // step (crew/van assignment, or the diary if it isn't booked yet) so it
      // isn't left to memory.
      const next =
        kind === "deposit" && leadId
          ? moveDay
            ? { label: "Assign crew", href: `/schedule/board?week=${moveDay}` }
            : { label: "Book removal", href: `/schedule/removals?leadId=${leadId}` }
          : null;
      toast.success(
        `${kind === "deposit" ? "Deposit" : "Balance"} marked paid (${method === "cash" ? "cash" : "bank transfer"}).`,
        next ? { duration: 8000, action: { label: next.label, onClick: () => router.push(next.href) } } : undefined,
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} className="bg-mm-red text-white hover:bg-mm-red-deep">
        <Check className="size-4" strokeWidth={2} />
        {kind === "deposit" ? "Deposit received" : "Balance received"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              {gbp(amount)} {kind} received
            </DialogTitle>
            <DialogDescription>
              {customerName ?? "The customer"} — how did it arrive? This records the payment in
              Zoho and emails their confirmation.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => pay("bank_transfer")}
              className="h-14 flex-col gap-1"
            >
              <Landmark className="size-5 text-mm-red" strokeWidth={1.75} />
              Bank transfer
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => pay("cash")}
              className="h-14 flex-col gap-1"
            >
              <Banknote className="size-5 text-success" strokeWidth={1.75} />
              Cash
            </Button>
          </div>
          <DialogFooter>
            {pending ? <Loader2 className="size-4 animate-spin text-mist-400" strokeWidth={1.75} /> : null}
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CopyLinkButton({ url }: { url: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast.success("Payment link copied.");
        } catch {
          toast.error("Could not copy — long-press the link instead.");
        }
      }}
    >
      <Link2 className="size-4" strokeWidth={1.75} />
      Copy link
    </Button>
  );
}
