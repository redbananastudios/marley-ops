"use client";

/**
 * Cancel-booking dialog — the one cancellation surface (Payments Policy v2,
 * docs/payments-policy-v2-prd.md §5C). Asks WHO is cancelling:
 *
 *  Customer cancelled → routes through the mark-lost unwind (reason recorded,
 *  invoices voided) and, when money is held, a refund-queue row: post-
 *  confirmation the row asks "did we re-book the day?"; pre-confirmation
 *  everything refunds in full.
 *
 *  We cancelled (Marley) → unconditional full refund, apology email, unpaid
 *  invoices voided. No fill question, ever.
 *
 * Requires an explicit tick before the destructive action. No string here
 * ever says "penalty" (test-enforced).
 *
 * NOT mounted anywhere by this file — export only. Mount from the bookings
 * rows and the lead-page header (integration step).
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
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
  cancelBookingAction,
  fetchHeldSummaryAction,
  type HeldSummary,
} from "@/app/actions/booking-change";
import {
  CANCEL_CONFIRMED_WARNING,
  CANCEL_UNCONFIRMED_NOTE,
  MARLEY_CANCEL_NOTE,
} from "@/lib/comms/cancellation-emails";
import { LOSS_REASONS } from "@/lib/quote/chase";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function CancelBookingDialog({
  leadId,
  open,
  onOpenChange,
  onDone,
}: {
  leadId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [by, setBy] = useState<"customer" | "marley">("customer");
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [held, setHeld] = useState<HeldSummary | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    setBy("customer");
    setReason(null);
    setNote("");
    setAcknowledged(false);
    setHeld(null);
    fetchHeldSummaryAction(leadId).then((res) => {
      if (res.ok) setHeld(res);
    });
  }, [open, leadId]);

  function submit() {
    if (by === "customer" && !reason) {
      toast.error("Pick a reason — it feeds the why-we-lose report.");
      return;
    }
    if (!acknowledged) {
      toast.error("Tick the box to confirm the cancellation.");
      return;
    }
    start(async () => {
      const res = await cancelBookingAction({
        leadId,
        by,
        reason: by === "customer" ? (reason ?? undefined) : undefined,
        note: note.trim() || undefined,
      });
      if (!res.ok) {
        toast.error(res.error || "Could not cancel the booking.");
        return;
      }
      const bits = [
        res.apptsCancelled
          ? `${res.apptsCancelled} appointment${res.apptsCancelled === 1 ? "" : "s"} cancelled`
          : null,
        res.voidedInvoices
          ? `${res.voidedInvoices} unpaid invoice${res.voidedInvoices === 1 ? "" : "s"} voided in Zoho`
          : null,
      ].filter(Boolean);
      toast.success(`Booking cancelled.${bits.length ? ` ${bits.join(" · ")}.` : ""}`);
      if (res.refundQueued) {
        toast.warning("Money is held on this job — the refund review is on the Refunds page.");
      }
      onOpenChange(false);
      onDone?.();
      router.refresh();
    });
  }

  const heldTotal = held?.total ?? 0;
  const dirty = reason !== null || note.trim() !== "" || acknowledged;

  return (
    <Dialog open={open} onOpenChange={(v) => (pending ? null : onOpenChange(v))}>
      <DialogContent
        onInteractOutside={(e) => {
          if (pending || dirty) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Cancel this booking</DialogTitle>
          <DialogDescription>
            Who is cancelling decides what happens to the money — nothing is refunded or retained
            without a button press on the Refunds page.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { value: "customer", label: "Customer cancelled" },
                { value: "marley", label: "We cancelled (Marley)" },
              ] as const
            ).map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setBy(o.value)}
                aria-pressed={by === o.value}
                className={cn(
                  "focus-ring min-h-11 rounded-md border px-3 text-sm font-medium transition-colors",
                  by === o.value
                    ? "border-mm-red bg-mm-red text-white"
                    : "border-input bg-card text-foreground hover:bg-muted",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>

          {by === "customer" ? (
            <div className="grid grid-cols-2 gap-2">
              {LOSS_REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setReason(r.value)}
                  aria-pressed={reason === r.value}
                  className={cn(
                    "focus-ring min-h-10 rounded-md border px-3 text-sm transition-colors",
                    reason === r.value
                      ? "border-mm-red bg-mm-red text-white"
                      : "border-input bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          ) : null}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note — anything worth remembering"
            rows={2}
            className="focus-ring w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          />

          <div className="space-y-2 rounded-md border border-warn/40 bg-warn-bg/40 p-3 text-sm">
            {by === "marley" ? (
              <p className="font-medium">{MARLEY_CANCEL_NOTE}</p>
            ) : held && heldTotal > 0 ? (
              <p className="font-medium">
                {held.dateConfirmed ? CANCEL_CONFIRMED_WARNING : CANCEL_UNCONFIRMED_NOTE}
              </p>
            ) : (
              <p className="font-medium">
                Nothing has been paid on this job — the booking simply cancels and chasing stops.
              </p>
            )}
            {held && heldTotal > 0 ? (
              <div className="text-muted-foreground">
                <p>
                  Paid so far: <strong>{gbp(heldTotal)}</strong>
                  {held.lines.length ? ` (${held.lines.join(", ")})` : ""}.
                </p>
                {by !== "marley" && held.dateConfirmed ? (
                  <p>
                    {gbp(held.conditional)} is held against the booked date — refunded in full if the
                    day re-books.{" "}
                    {held.unconditional > 0 ? `${gbp(held.unconditional)} refunds regardless.` : ""}
                  </p>
                ) : null}
              </div>
            ) : null}
            <label className="flex items-start gap-2 pt-1 text-sm font-medium">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="focus-ring mt-0.5 size-4 accent-mm-red"
              />
              <span>I understand — cancel this booking.</span>
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Keep the booking
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !acknowledged || (by === "customer" && !reason)}
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <X className="size-4" strokeWidth={1.75} />
            )}
            Cancel the booking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
