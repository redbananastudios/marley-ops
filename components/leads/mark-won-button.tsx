"use client";

/**
 * "Mark won" on a lead — routes through quote acceptance so a win always carries a
 * number. If the lead has an open quote, it captures the agreed price (defaults to
 * the quoted total, editable) and accepts that quote, which records the booked
 * revenue and confirms the lead. If there's no quote yet, it nudges to build one
 * (the right path) but still allows a no-value win as a deliberate, labelled choice.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trophy, Loader2, FileText } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { acceptQuote } from "@/app/(dashboard)/quotes/actions";
import { updateLeadStatusAction } from "@/app/(dashboard)/leads/actions";

export interface WonQuote {
  id: string;
  quote_ref: string;
  grand_total: number | null;
  status: string;
}

const gbp = (n: number): string => "£" + Number(n).toLocaleString("en-GB");

export function MarkWonButton({
  leadId,
  quotes,
  className,
}: {
  leadId: string;
  quotes: WonQuote[];
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Quotes that can still be accepted (not already accepted / rejected / superseded).
  const acceptable = useMemo(
    () => quotes.filter((q) => q.status === "draft" || q.status === "sent"),
    [quotes],
  );

  const [quoteId, setQuoteId] = useState(acceptable[0]?.id ?? "");
  const [price, setPrice] = useState("");

  const selected = acceptable.find((q) => q.id === quoteId) ?? acceptable[0];

  useEffect(() => {
    if (!open) return;
    const first = acceptable[0];
    setQuoteId(first?.id ?? "");
    setPrice(first ? String(first.grand_total ?? 0) : "");
  }, [open, acceptable]);

  // Keep the price in step with the chosen quote.
  useEffect(() => {
    if (selected) setPrice(String(selected.grand_total ?? 0));
  }, [quoteId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function winWithQuote() {
    const value = Number(price);
    if (!selected) return;
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter the agreed price.");
      return;
    }
    setBusy(true);
    const res = await acceptQuote(selected.id, value);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not mark won.");
      return;
    }
    toast.success(
      `Won — ${gbp(value)} booked. ${
        res.emailed ? "Deposit payment email sent." : "No email on file — send the payment link from Bookings."
      }`,
    );
    setOpen(false);
    router.refresh();
  }

  async function winWithoutValue() {
    setBusy(true);
    const res = await updateLeadStatusAction(leadId, "confirmed");
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error || "Could not mark won.");
      return;
    }
    toast.success("Marked won (no value recorded).");
    setOpen(false);
    router.refresh();
  }

  const hasQuote = acceptable.length > 0;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <Trophy className="size-4" strokeWidth={2} />
        Mark won
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Mark won</DialogTitle>
            <DialogDescription>
              {hasQuote
                ? "Records the agreed price and starts the booking: the customer gets their deposit payment link by email, and the lead sits in Provisional until the deposit lands (then confirms itself). Track it in Bookings."
                : "There's no quote on this lead yet. Build one so the win carries a value, or confirm without a recorded figure."}
            </DialogDescription>
          </DialogHeader>

          {hasQuote ? (
            <div className="grid gap-4 py-2">
              {acceptable.length > 1 ? (
                <div className="grid gap-2">
                  <Label htmlFor="won-quote">Quote</Label>
                  <Select value={quoteId} onValueChange={setQuoteId}>
                    <SelectTrigger id="won-quote">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {acceptable.map((q) => (
                        <SelectItem key={q.id} value={q.id}>
                          {q.quote_ref} · {gbp(Number(q.grand_total ?? 0))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div>
                <Label htmlFor="won-price" className="mb-2 block">
                  Agreed price
                </Label>
                <div className="flex h-12 items-center rounded-md border border-input bg-card px-3 focus-within:border-mm-red focus-within:ring-2 focus-within:ring-mm-red/30">
                  <span className="mr-1 text-base text-mist-400">£</span>
                  <input
                    id="won-price"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="tabular h-full w-full bg-transparent text-base text-foreground focus:outline-none"
                  />
                </div>
                {selected ? (
                  <p className="mt-1.5 text-xs text-mist-400">
                    Quoted total {gbp(Number(selected.grand_total ?? 0))}. Edit if the final figure differs.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <DialogFooter className="gap-2">
            {hasQuote ? (
              <>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={winWithQuote} disabled={busy} className="bg-mm-red text-white hover:bg-mm-red-deep">
                  {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <Trophy className="size-4" strokeWidth={1.75} />}
                  Confirm won
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={winWithoutValue} disabled={busy} className="text-mist-500">
                  Win without a value
                </Button>
                <Button asChild className="bg-mm-red text-white hover:bg-mm-red-deep">
                  <Link href={`/quotes/new?leadId=${leadId}`} prefetch={false}>
                    <FileText className="size-4" strokeWidth={1.75} />
                    Build a quote
                  </Link>
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
