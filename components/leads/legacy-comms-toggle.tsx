"use client";

/**
 * The office's switch for a legacy iMVE booking's automated customer email.
 *
 * Imported bookings arrive hard-excluded from every automated email and money
 * flow — those customers agreed to the OLD system's terms, so nothing may be
 * sent that they weren't told about. Luke phones each one ~8-9 days before
 * the move; this switch records that call. ON = the booking behaves like any
 * other from that moment (T-7 final invoice, money reminders). OFF restores
 * the hands-off import state.
 *
 * Sits beside the "Legacy (iMVE)" chip so the state and its meaning read
 * together on the lead header.
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setStandardCommsAction } from "@/app/(dashboard)/leads/actions";

export function LegacyCommsToggle({ quoteId, enabledAt }: { quoteId: string; enabledAt: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const enabled = !!enabledAt;

  const flip = () =>
    start(async () => {
      const res = await setStandardCommsAction(quoteId, !enabled);
      if (!res.ok) toast.error(res.error || "Something went wrong.");
      else {
        toast.success(
          enabled
            ? "Standard comms OFF — booking is hands-off again."
            : "Standard comms ON — automated emails now apply to this booking.",
        );
        router.refresh();
      }
    });

  return (
    <button
      type="button"
      onClick={flip}
      disabled={pending}
      className={
        enabled
          ? "inline-flex items-center rounded-pill bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-200 disabled:opacity-50"
          : "inline-flex items-center rounded-pill border border-dashed border-mist-300 bg-transparent px-2.5 py-1 text-xs font-semibold text-mist-500 transition hover:bg-muted disabled:opacity-50"
      }
      title={
        enabled
          ? "Automated emails apply to this booking (customer informed by phone). Click to switch back to hands-off."
          : "No automated email goes to this customer. Click AFTER they have been phoned about the current arrangements."
      }
    >
      {pending ? "…" : enabled ? "Standard comms ON" : "Standard comms off"}
    </button>
  );
}
