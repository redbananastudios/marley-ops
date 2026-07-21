"use client";

/**
 * Change-date dialog for a booked removal (Payments Policy v2 — the single
 * date-change path, docs/payments-policy-v2-prd.md §5C).
 *
 * Outside the 7-day window the change is free — everything rolls and the
 * booking stays confirmed. Inside the window the dialog shows the policy
 * warning verbatim, what is held and the fill rule, and requires an explicit
 * tick before the destructive cancel-and-rebook runs. No customer-facing or
 * office-facing string here ever says "penalty" (test-enforced).
 *
 * NOT mounted anywhere by this file — export only. Mount from the bookings
 * Booked rows and the lead-page appointment card (integration step).
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2 } from "lucide-react";
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
  changeBookingDateAction,
  fetchHeldSummaryAction,
  type HeldSummary,
} from "@/app/actions/booking-change";
import { bookingChangeMode, INSIDE_WINDOW_CHANGE_WARNING } from "@/lib/comms/cancellation-emails";
import { ukDayOf } from "@/lib/sales-report";

const gbp = (n: number): string =>
  "£" +
  Number(n)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** ISO instant → the value a datetime-local input wants (local wall clock). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ChangeDateDialog({
  appointmentId,
  leadId,
  startsAt,
  endsAt,
  presetStartsAt,
  presetEndsAt,
  open,
  onOpenChange,
  onDone,
}: {
  appointmentId: string;
  leadId: string;
  /** Current slot (ISO instants) — the window is judged against THIS date. */
  startsAt: string;
  endsAt: string;
  /** Optional pre-filled NEW slot (e.g. a diary drag target). The inside/
   *  outside window is still judged against startsAt, never the preset. */
  presetStartsAt?: string | null;
  presetEndsAt?: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [held, setHeld] = useState<HeldSummary | null>(null);
  const [pending, start] = useTransition();

  // Inside/outside is judged against the ORIGINAL move day, not the new one.
  const inside = useMemo(() => bookingChangeMode(ukDayOf(startsAt)) === "cancel_rebook", [startsAt]);

  useEffect(() => {
    if (!open) return;
    setNewStart(toLocalInput(presetStartsAt ?? startsAt));
    setNewEnd(toLocalInput(presetEndsAt ?? endsAt));
    setAcknowledged(false);
    setHeld(null);
    if (inside) {
      fetchHeldSummaryAction(leadId).then((res) => {
        if (res.ok) setHeld(res);
      });
    }
  }, [open, startsAt, endsAt, presetStartsAt, presetEndsAt, inside, leadId]);

  // Moving the start shifts the end by the same amount, keeping the duration.
  function onStartChange(value: string) {
    const prev = new Date(newStart);
    const next = new Date(value);
    const end = new Date(newEnd);
    if (!Number.isNaN(prev.getTime()) && !Number.isNaN(next.getTime()) && !Number.isNaN(end.getTime())) {
      setNewEnd(toLocalInput(new Date(end.getTime() + (next.getTime() - prev.getTime())).toISOString()));
    }
    setNewStart(value);
  }

  function submit() {
    const s = new Date(newStart);
    const e = new Date(newEnd);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
      toast.error("Pick the new date and time.");
      return;
    }
    if (e.getTime() <= s.getTime()) {
      toast.error("The end time must be after the start time.");
      return;
    }
    if (inside && !acknowledged) {
      toast.error("Tick the box to confirm the customer understands the change.");
      return;
    }
    start(async () => {
      const res = await changeBookingDateAction(appointmentId, s.toISOString(), e.toISOString());
      if (!res.ok) {
        toast.error(res.error || "Could not change the date.");
        return;
      }
      if (res.mode === "rescheduled") {
        toast.success("Date moved — the booking and everything paid roll with it.");
      } else {
        toast.success("Original date released and the new date booked.");
        if (res.queued) {
          toast.warning("Money is held against the original date — the review is on the Refunds page.");
        }
      }
      onOpenChange(false);
      onDone?.();
      router.refresh();
    });
  }

  const heldTotal = held?.total ?? 0;

  return (
    <Dialog open={open} onOpenChange={(v) => (pending ? null : onOpenChange(v))}>
      <DialogContent
        onInteractOutside={(e) => {
          if (pending || acknowledged || newStart !== toLocalInput(startsAt)) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Change the move date</DialogTitle>
          <DialogDescription>
            {inside
              ? "This booking is within 7 days of its move date, so the change releases the original day."
              : "More than 7 days out — the change is free and everything rolls with the new date."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <label className="block text-sm font-medium">
            New start
            <input
              type="datetime-local"
              value={newStart}
              onChange={(e) => onStartChange(e.target.value)}
              className="focus-ring mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm font-medium">
            New end
            <input
              type="datetime-local"
              value={newEnd}
              onChange={(e) => setNewEnd(e.target.value)}
              className="focus-ring mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            />
          </label>

          {inside ? (
            <div className="space-y-2 rounded-md border border-warn/40 bg-warn-bg/40 p-3 text-sm">
              <p className="font-medium">{INSIDE_WINDOW_CHANGE_WARNING}</p>
              {held ? (
                heldTotal > 0 ? (
                  <div className="text-muted-foreground">
                    <p>
                      Paid so far: <strong>{gbp(heldTotal)}</strong>
                      {held.lines.length ? ` (${held.lines.join(", ")})` : ""}.
                    </p>
                    {held.dateConfirmed ? (
                      <p>
                        {gbp(held.conditional)} is held against the original date — refunded in full if
                        the day re-books. {held.unconditional > 0 ? `${gbp(held.unconditional)} counts towards the new booking regardless.` : ""}
                      </p>
                    ) : (
                      <p>The date was never confirmed, so nothing is retainable — it all counts towards the new booking.</p>
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground">Nothing has been paid yet — the date simply moves.</p>
                )
              ) : (
                <p className="text-muted-foreground">Checking what has been paid…</p>
              )}
              <label className="flex items-start gap-2 pt-1 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="focus-ring mt-0.5 size-4 accent-mm-red"
                />
                <span>
                  I have explained this to the customer and they want to go ahead.
                </span>
              </label>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Keep the current date
          </Button>
          <Button
            onClick={submit}
            disabled={pending || (inside && !acknowledged)}
            className="bg-mm-red text-white hover:bg-mm-red-deep"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <CalendarClock className="size-4" strokeWidth={1.75} />
            )}
            {inside ? "Release old date & rebook" : "Move the date"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
