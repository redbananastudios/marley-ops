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
import { reportSurveySend, duplicateWarning } from "@/lib/comms/survey-send-report";
import { UK_TZ, ukCalendarDate } from "@/lib/uk-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ignorePortalInteractOutside,
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
  /** time-grid drag: the dropped slot is exact, so it wins outright (a month
   *  drop carries no meaningful time, which is why the two are separate). */
  presetExact,
  /** "sam@example.com · 07700 900123" — who the new-time message would reach.
   *  Absent means the caller couldn't resolve contact details, so the tick box
   *  falls back to generic wording rather than disappearing. */
  customerContact,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  target: EditTarget | null;
  estimatorName: string | null;
  events: SchedulerEvent[];
  presetDate?: Date | null;
  presetExact?: Date | null;
  customerContact?: string | null;
}) {
  const router = useRouter();
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  // Surveys mail the customer straight from here (before 2026-08-08 they mailed
  // nobody at all). Same visible-choice rule as the booking dialog.
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  useEffect(() => {
    if (!open || !target) return;
    const cur = new Date(target.startsAt);
    if (presetExact) {
      setWhen(toLocalInput(new Date(presetExact)));
    } else if (presetDate) {
      const d = new Date(presetDate);
      d.setHours(cur.getHours(), cur.getMinutes(), 0, 0);
      setWhen(toLocalInput(d));
    } else {
      setWhen(toLocalInput(cur));
    }
    setNotifyCustomer(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.id, presetDate?.getTime(), presetExact?.getTime()]);

  // Only surveys write to the customer from this dialog — a booked removal's
  // date change goes through ChangeDateDialog, which owns its own email.
  const isSurvey = target?.apptType === "survey";

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
          // Day membership pinned to the UK calendar (lib/uk-time.ts header
          // rule: rendered date text must pin UK_TZ) — a viewer an hour off
          // otherwise sees the wrong day's bookings and double-books a slot
          // this panel said was clear.
          ukCalendarDate(e.starts_at) === day,
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
        { notifyCustomer },
      );
      if (!r.ok) {
        toast.error(r.error || "Could not reschedule.");
        return;
      }
      const rep = "comms" in r && r.comms ? reportSurveySend(r.comms) : null;
      if (rep?.sent) toast.success(`Appointment moved — new time sent by ${rep.sent}.`);
      else if (isSurvey && !notifyCustomer) toast.success("Appointment moved. Nothing sent to the customer.");
      else toast.success("Appointment moved.");
      if (rep?.duplicate) toast.warning(duplicateWarning(rep.duplicate));
      if (rep?.failed) {
        toast.error(`Moved, but the new time didn't reach them by ${rep.failed} — call them.`);
      }
      onOpenChange(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!target) return null;

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: UK_TZ });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onInteractOutside={ignorePortalInteractOutside}>
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

          {/* Moving a survey used to send the customer nothing at all, so they
              kept an email for a time we no longer intended to turn up. It now
              sends, and whether it sends is a visible choice. */}
          {isSurvey ? (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <label className="flex cursor-pointer items-start gap-2.5 text-sm font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={notifyCustomer}
                  onChange={(e) => setNotifyCustomer(e.target.checked)}
                  className="mt-0.5 size-4 accent-[#C03838]"
                />
                <span>
                  Tell the customer the new time
                  {customerContact ? (
                    <span className="mt-0.5 block text-xs font-normal text-mist-400">{customerContact}</span>
                  ) : null}
                </span>
              </label>
              {!notifyCustomer ? (
                <p className="mt-2 text-xs text-mist-500">
                  Nothing will be sent. They will still be expecting the old time.
                </p>
              ) : null}
            </div>
          ) : null}
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
