"use client";

/**
 * Trigger buttons for the Payments Policy v2 booking dialogs (integration
 * mount — the dialogs themselves live in change-date-dialog.tsx and
 * cancel-booking-dialog.tsx and are export-only by design).
 *
 *  - ChangeDateButton   → ChangeDateDialog: THE single date-change path for a
 *    booked removal (free reschedule outside the 7-day window; warned
 *    cancel-and-rebook + refund-queue row inside it).
 *  - CancelBookingButton → CancelBookingDialog: the one cancellation surface
 *    for deposit-paid leads (customer cancels route through mark-lost
 *    internally; Marley cancels refund everything).
 *
 * Mounted on the /bookings Booked rows and the lead page header.
 */

import { useState } from "react";
import { CalendarClock, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChangeDateDialog } from "@/components/bookings/change-date-dialog";
import { CancelBookingDialog } from "@/components/bookings/cancel-booking-dialog";

export function ChangeDateButton({
  appointmentId,
  leadId,
  startsAt,
  endsAt,
}: {
  appointmentId: string;
  leadId: string;
  startsAt: string;
  endsAt: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CalendarClock className="size-4" strokeWidth={1.75} />
        Change date
      </Button>
      <ChangeDateDialog
        appointmentId={appointmentId}
        leadId={leadId}
        startsAt={startsAt}
        endsAt={endsAt}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function CancelBookingButton({ leadId }: { leadId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="text-danger hover:text-danger"
        onClick={() => setOpen(true)}
      >
        <XCircle className="size-4" strokeWidth={1.75} />
        Cancel booking
      </Button>
      <CancelBookingDialog leadId={leadId} open={open} onOpenChange={setOpen} />
    </>
  );
}
