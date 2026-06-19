"use client";

/**
 * "Mark accepted" — records the agreed price (the booked revenue, defaulting to
 * the quoted total but editable, since real deals flex) and wins the lead.
 */

import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { acceptQuote } from "@/app/(dashboard)/quotes/actions";

export function AcceptQuoteButton({
  quoteId,
  grandTotal,
  status,
}: {
  quoteId: string;
  grandTotal: number;
  status: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(String(grandTotal ?? 0));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setPrice(String(grandTotal ?? 0));
  }, [open, grandTotal]);

  if (status === "accepted") return null;

  async function confirm() {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter the agreed price.");
      return;
    }
    setBusy(true);
    const res = await acceptQuote(quoteId, value);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not accept the quote.");
      return;
    }
    toast.success(`Accepted — £${value.toLocaleString("en-GB")} booked.`);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button
        type="button"
        onClick={() => setOpen(true)}
        className="bg-mm-red text-white hover:bg-mm-red-deep"
      >
        <CheckCircle2 className="size-4" strokeWidth={1.75} />
        Mark accepted
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Accept quote</DialogTitle>
            <DialogDescription>
              Record the price the customer agreed to. This becomes the booked revenue and moves the
              lead to Confirmed.
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
              Defaults to the quoted total (£{Number(grandTotal ?? 0).toLocaleString("en-GB")}). Edit
              if the final figure differs.
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
              Confirm accepted
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
