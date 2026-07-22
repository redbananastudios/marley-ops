"use client";

/**
 * "Needs decision" row — the one human question on a conditional refund entry:
 * did we re-book the old date? "Filled" is always available; "Not filled" only
 * unlocks once the date has passed (until then the day could still re-book).
 * Both answers confirm through a dialog with the money consequences spelled
 * out, and lock the UI while the action runs (no double-answers).
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { determineRefundQueueAction } from "@/app/actions/refunds";
import { gbpPence, RAIL_LABELS, type QueueItemView } from "@/lib/refunds/queue-view";

function dateLabel(day: string | null): string {
  if (!day) return "the original date";
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

export function DecisionCard({ item }: { item: QueueItemView }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<"filled" | "not_filled" | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const processing = busy || refreshing;
  const when = dateLabel(item.originalMoveDate);
  // A date-change row belongs to a STILL-LIVE booking: held money keeps
  // counting toward the new date — nothing ever pays out of this row.
  const isDateChange = item.trigger === "customer_date_change";

  async function answer(determination: "filled" | "not_filled") {
    setBusy(true);
    try {
      const res = await determineRefundQueueAction(item.id, determination);
      if (!res.ok) {
        toast.error(res.error || "Couldn't record the decision.");
        return;
      }
      if (res.already) {
        // Someone answered first (or a stale tab re-asked): report what is
        // ACTUALLY recorded, never the click that lost.
        const recorded = res.recorded;
        toast.warning(
          recorded === "filled"
            ? "Already answered — recorded as re-booked. Refreshing."
            : recorded === "not_filled"
              ? "Already answered — recorded as stayed empty. Refreshing."
              : "Already settled — refreshing.",
        );
      } else {
        toast.success(
          determination === "filled"
            ? isDateChange
              ? "Recorded — everything held keeps counting toward the new booking. Close the entry from the To execute list."
              : "Recorded — everything held is now refundable. Pay it out from the To execute list."
            : isDateChange
              ? "Recorded — the held amount is retained and stops counting toward the new booking. Settle the entry from the To execute list."
              : "Recorded — the held amount stays with the booking terms. Settle the entry from the To execute list.",
        );
      }
      setConfirming(null);
      startRefresh(() => router.refresh());
    } catch {
      toast.error("Couldn't reach the server — refresh and check before answering again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          {item.leadId ? (
            <Link href={`/leads/${item.leadId}`} className="font-medium text-foreground hover:underline">
              {item.customer}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{item.customer}</span>
          )}
          <p className="text-xs text-mist-400">
            {item.quoteRef ?? "—"} · {item.triggerLabel}
          </p>
        </div>
        <span className="tabular text-sm font-semibold text-foreground">{gbpPence(item.heldPence)} held</span>
      </div>

      <ul className="space-y-1">
        {item.rails.flatMap((rail) =>
          rail.payments.map((p) => (
            <li key={p.key} className="flex items-center justify-between text-xs text-mist-500">
              <span className="capitalize">
                {p.label} · {RAIL_LABELS[p.rail].toLowerCase()}
              </span>
              <span className="tabular">{gbpPence(p.amountPence)}</span>
            </li>
          )),
        )}
      </ul>

      {item.notes ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-mist-500">{item.notes}</p>
      ) : null}

      <div className="rounded-md bg-muted px-3 py-2.5">
        <p className="text-sm font-semibold text-foreground">Did we re-book {when}?</p>
        <p className="mt-0.5 text-xs text-mist-400">
          {isDateChange ? (
            <>
              Re-booked: everything held ({gbpPence(item.heldPence)}) keeps counting toward the new booking. Stayed
              empty: {gbpPence(item.conditionalPence)} is retained and stops counting
              {item.unconditionalPence > 0
                ? ` — the remaining ${gbpPence(item.unconditionalPence)} keeps counting regardless`
                : ""}
              .
            </>
          ) : (
            <>
              Re-booked: refund everything ({gbpPence(item.heldPence)}). Stayed empty: {gbpPence(item.conditionalPence)}{" "}
              is held under the booking terms
              {item.unconditionalPence > 0 ? ` and ${gbpPence(item.unconditionalPence)} is refunded regardless` : ""}.
            </>
          )}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setConfirming("filled")} disabled={processing}>
            {refreshing ? <Loader2 className="size-4 animate-spin" strokeWidth={2} /> : "Yes — the day re-booked"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming("not_filled")}
            disabled={processing || !item.notFilledAllowed}
          >
            No — it stayed empty
          </Button>
          {!item.notFilledAllowed ? (
            <span className="text-xs text-mist-400">
              You can answer &quot;stayed empty&quot; after {when} — until then the day could still re-book.
            </span>
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next && busy) return;
          if (!next) setConfirming(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirming === "filled" ? "The day re-booked" : "The day stayed empty"}
            </DialogTitle>
          </DialogHeader>
          {confirming === "filled" ? (
            <p className="text-sm leading-relaxed text-mist-500">
              {isDateChange ? (
                <>
                  Everything held ({gbpPence(item.heldPence)}) keeps counting toward the new booking — nothing is
                  refunded and no email is sent. You&apos;ll close the entry from the To execute list next.
                </>
              ) : (
                <>
                  Everything held ({gbpPence(item.heldPence)}) becomes refundable in full. You&apos;ll pay it out from
                  the To execute list next — nothing is sent to the customer until the refunds are done.
                </>
              )}
            </p>
          ) : (
            <p className="text-sm leading-relaxed text-mist-500">
              {isDateChange ? (
                <>
                  {gbpPence(item.conditionalPence)} is retained against {when} and stops counting toward the new
                  booking — the balance invoice for the new date increases by the same amount.
                  {item.unconditionalPence > 0
                    ? ` ${gbpPence(item.unconditionalPence)} above that keeps counting toward the new booking.`
                    : ""}{" "}
                  The customer is told once you settle the entry.
                </>
              ) : (
                <>
                  {gbpPence(item.conditionalPence)} stays held against {when}, as the booking terms set out.
                  {item.unconditionalPence > 0
                    ? ` ${gbpPence(item.unconditionalPence)} above that is still refunded in full.`
                    : ""}{" "}
                  The customer is told once you settle the entry.
                </>
              )}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => confirming && answer(confirming)}
              disabled={processing}
              className="bg-mm-red text-white hover:bg-mm-red-deep"
            >
              {processing ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" strokeWidth={2} /> Recording…
                </span>
              ) : confirming === "filled" ? (
                "Record: re-booked"
              ) : (
                "Record: stayed empty"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
