"use client";

/**
 * Reschedule an appointment to a new date + time. Used two ways:
 *  - the "Reschedule" button on the appointment view modal
 *  - dropping an event on a MONTH-view day (a date with no time) — the drop is
 *    reverted and this dialog opens preset to the target date instead.
 * Shows the estimator's other appointments on the chosen day so the person
 * rescheduling can see availability before committing.
 */

import { useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rescheduleAppointment } from "@/app/(dashboard)/schedule/actions";
import type { SchedulerEvent } from "./scheduler-view";
import type { EditTarget } from "./appointment-dialog";

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RescheduleDialog({
  open,
  onOpenChange,
  target,
  estimatorName,
  events,
  /** month-view drop: pre-set the DATE, keep the original time as the suggestion */
  presetDate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  target: EditTarget | null;
  estimatorName: string | null;
  events: SchedulerEvent[];
  presetDate?: Date | null;
}) {
  const router = useRouter();
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !target) return;
    const cur = new Date(target.startsAt);
    if (presetDate) {
      const d = new Date(presetDate);
      d.setHours(cur.getHours(), cur.getMinutes(), 0, 0);
      setWhen(toLocalInput(d));
    } else {
      setWhen(toLocalInput(cur));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.id, presetDate?.getTime()]);

  const durationMs = useMemo(() => {
    if (!target) return 60 * 60 * 1000;
    const ms = new Date(target.endsAt).getTime() - new Date(target.startsAt).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : 60 * 60 * 1000;
  }, [target]);

  /* The estimator's other bookings on the chosen day — availability at a glance. */
  const dayBookings = useMemo(() => {
    if (!target || !when) return [];
    const day = when.slice(0, 10);
    return events
      .filter(
        (e) =>
          e.id !== target.id &&
          e.status !== "cancelled" &&
          e.estimator_id === target.estimatorId &&
          toLocalInput(new Date(e.starts_at)).slice(0, 10) === day,
      )
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  }, [events, target, when]);

  async function onConfirm() {
    if (!target) return;
    const start = new Date(when);
    if (!when || Number.isNaN(start.getTime())) {
      toast.error("Pick the new date and time.");
      return;
    }
    setBusy(true);
    try {
      const r = await rescheduleAppointment(
        target.id,
        start.toISOString(),
        new Date(start.getTime() + durationMs).toISOString(),
      );
      if (!r.ok) {
        toast.error(r.error || "Could not reschedule.");
        return;
      }
      toast.success("Appointment moved.");
      onOpenChange(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!target) return null;

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <CalendarClock className="size-5 text-mm-red" strokeWidth={1.75} />
            Reschedule
          </DialogTitle>
          <DialogDescription>{target.title ?? "Appointment"} — pick the new date and time.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="resched-when">New date &amp; time</Label>
            <Input
              id="resched-when"
              type="datetime-local"
              step={900}
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>

          {/* availability on the chosen day */}
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="mb-1.5 text-[11px] font-bold tracking-[0.14em] text-mist-400 uppercase">
              {estimatorName ?? "Estimator"} that day
            </p>
            {dayBookings.length === 0 ? (
              <p className="text-sm text-mist-500">No other appointments — the day is clear.</p>
            ) : (
              <ul className="space-y-1">
                {dayBookings.map((b) => (
                  <li key={b.id} className="flex items-center gap-2 text-sm text-foreground">
                    <span className="tabular font-medium">
                      {fmtTime(b.starts_at)}
                      {b.ends_at ? `–${fmtTime(b.ends_at)}` : ""}
                    </span>
                    <span className="min-w-0 truncate text-mist-500">{b.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-11">
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={busy} className="h-11">
            {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : null}
            Move appointment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
