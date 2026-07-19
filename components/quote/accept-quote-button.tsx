"use client";

/**
 * "Accept quote" — the staff-side conversion (customer said yes on the phone).
 * One confirm dialog, then the full booking machine runs: agreed price locked,
 * lead to Provisional, £deposit requested with the payment email sent to the
 * customer, Zoho deposit invoice raised. The lead confirms itself when the
 * deposit lands, and the job appears in Bookings → Awaiting deposit.
 *
 * `compact` renders the small quotes-list trigger; default is the quote-page
 * header button.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { acceptQuote } from "@/app/(dashboard)/quotes/actions";

const gbp = (n: number): string => "£" + Number(n).toLocaleString("en-GB");

export function AcceptQuoteButton({
  quoteId,
  grandTotal,
  status,
  depositAmount = 100,
  compact,
  className,
}: {
  quoteId: string;
  grandTotal: number;
  status: string;
  /** Settings defaultDeposit — shown in the dialog so the amount is never a surprise. */
  depositAmount?: number;
  compact?: boolean;
  /** Extra classes on the default (non-compact) trigger — lets the quote header
   *  size it as the page's primary CTA (h-11, full-width on mobile). */
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(String(grandTotal ?? 0));
  const [deposit, setDeposit] = useState(String(depositAmount));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPrice(String(grandTotal ?? 0));
      setDeposit(String(depositAmount));
    }
  }, [open, grandTotal, depositAmount]);

  // Only live quotes convert; accepted ones link to Bookings from elsewhere.
  if (status !== "draft" && status !== "sent") return null;

  async function confirm() {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter the agreed price.");
      return;
    }
    const dep = Number(deposit);
    if (!Number.isFinite(dep) || dep <= 0) {
      toast.error("Enter the deposit to request.");
      return;
    }
    if (dep >= value) {
      toast.error("The deposit must be less than the agreed price.");
      return;
    }
    setBusy(true);
    try {
      const res = await acceptQuote(quoteId, value, dep);
      if (!res.ok) {
        toast.error(res.error || "Could not accept the quote.");
        return;
      }
      toast.success(
        `Accepted — ${gbp(res.agreedPrice)} booked. ${
          res.emailed
            ? `Payment email sent (${gbp(res.deposit ?? depositAmount)} deposit).`
            : "No customer email on file — send the payment link from Bookings."
        }`,
      );
      setOpen(false);
      router.refresh();
    } catch {
      // acceptQuote is idempotent (never-create-twice) — retry is safe.
      toast.error("Couldn't reach the server — check Bookings before retrying.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {compact ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="shrink-0">
          <CheckCircle2 className="size-4 text-success" strokeWidth={1.75} />
          Accept
        </Button>
      ) : (
        <Button
          type="button"
          onClick={() => setOpen(true)}
          className={cn("bg-mm-red text-white hover:bg-mm-red-deep", className)}
        >
          <CheckCircle2 className="size-4" strokeWidth={1.75} />
          Accept quote
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Accept quote</DialogTitle>
            <DialogDescription>
              This starts the booking: the customer gets an email with their deposit payment
              link, the deposit invoice is raised in Zoho, and the lead sits in{" "}
              <strong>Provisional</strong> — it confirms automatically the moment the deposit
              lands. Track it in{" "}
              <Link href="/bookings" className="underline underline-offset-2">
                Bookings
              </Link>
              .
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            <Label htmlFor="agreed-price" className="mb-2 block">
              Agreed price
            </Label>
            <div className="flex h-12 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30">
              <span className="mr-1 text-base text-mist-400">£</span>
              <input
                id="agreed-price"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="tabular h-full w-full bg-transparent text-base text-foreground focus:outline-none"
              />
            </div>
            <p className="mt-1.5 text-xs text-mist-400">
              Defaults to the quoted total ({gbp(Number(grandTotal ?? 0))}). Edit if the final
              figure differs — the balance invoice later uses this number less the deposit.
            </p>

            <Label htmlFor="accept-deposit" className="mt-4 mb-2 block">
              Deposit to request
            </Label>
            <div className="flex h-12 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30">
              <span className="mr-1 text-base text-mist-400">£</span>
              <input
                id="accept-deposit"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
                className="tabular h-full w-full bg-transparent text-base text-foreground focus:outline-none"
              />
            </div>
            <p className="mt-1.5 text-xs text-mist-400">
              Standard is {gbp(depositAmount)} — raise it for bigger jobs if you want more down.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
              {busy ? (
                <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
              ) : (
                <CheckCircle2 className="size-4" strokeWidth={1.75} />
              )}
              Accept &amp; request deposit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
