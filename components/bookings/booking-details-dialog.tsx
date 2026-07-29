"use client";

/**
 * Shared booking-details drawer (design doc docs/schedule-allocation-design.md,
 * D4/D7/D9) — the single capture UI for a lead's move window: approximate
 * window in the customer's own words, target month, provisional date, and the
 * homeowner/rented date-flex flag. Opened from the lead record, the Bookings
 * page, the /schedule soft-demand panel and the day summary.
 *
 * Money is NEVER edited here. Deposit/25% state arrives as optional read-only
 * context so the office can see what the customer has committed while setting
 * the window — payments stay owned by the quote and bookings flow.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2, Truck, UsersRound } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { saveBookingDetailsAction } from "@/app/actions/booking-details";

export interface BookingDetailsInitial {
  approxWindow: string | null;
  /** ISO first-of-month date ("YYYY-MM-01") as stored, or null. */
  approxMonth: string | null;
  provisionalDate: string | null;
  propertyType: string | null;
}

/** Read-only payment/requirement context — display only, never editable here. */
export interface BookingDetailsContext {
  requiredVans?: number | null;
  requiredCrew?: number | null;
  depositPaid?: boolean;
  commitmentPaid?: boolean;
}

const PROPERTY_OPTIONS = [
  { value: "homeowner", label: "Homeowner", hint: "Date fixed by their sale." },
  { value: "rented", label: "Rented", hint: "Date can flex." },
  { value: "", label: "Not set", hint: "Ask when they next call." },
] as const;

const fieldClass =
  "focus-ring mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground";

function ContextChip({ tone, children }: { tone?: "on"; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[11px] font-medium",
        tone === "on" ? "border-border bg-muted text-mist-500" : "border-border bg-muted/40 text-mist-400",
      )}
    >
      {children}
    </span>
  );
}

export function BookingDetailsDialog({
  leadId,
  leadName,
  initial,
  context,
  open,
  onOpenChange,
}: {
  leadId: string;
  leadName: string;
  initial: BookingDetailsInitial;
  context?: BookingDetailsContext | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}): React.JSX.Element {
  const router = useRouter();
  const [approxWindow, setApproxWindow] = useState("");
  const [approxMonth, setApproxMonth] = useState("");
  const [provisionalDate, setProvisionalDate] = useState("");
  const [propertyType, setPropertyType] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    setApproxWindow(initial.approxWindow ?? "");
    // The month input wants "YYYY-MM"; the DB stores a first-of-month date.
    setApproxMonth(initial.approxMonth ? initial.approxMonth.slice(0, 7) : "");
    setProvisionalDate(initial.provisionalDate ?? "");
    setPropertyType(initial.propertyType === "homeowner" || initial.propertyType === "rented" ? initial.propertyType : "");
  }, [open, initial.approxWindow, initial.approxMonth, initial.provisionalDate, initial.propertyType]);

  const hasContext =
    !!context &&
    (context.requiredVans != null ||
      context.requiredCrew != null ||
      context.depositPaid !== undefined ||
      context.commitmentPaid !== undefined);

  function submit() {
    start(async () => {
      const res = await saveBookingDetailsAction({
        leadId,
        approxWindow: approxWindow || null,
        approxMonth: approxMonth || null,
        provisionalDate: provisionalDate || null,
        propertyType: propertyType || null,
      });
      if (!res.ok) {
        toast.error(res.error || "Could not save the move window.");
        return;
      }
      toast.success("Move window saved.");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (pending ? null : onOpenChange(v))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Move window · {leadName}</DialogTitle>
          <DialogDescription>
            The soft picture of when this move happens. Nothing here books the diary — only the
            confirmed date does that.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* When are they thinking? */}
          <div className="space-y-3">
            <p className="eyebrow">When are they thinking?</p>
            <label className="block text-sm font-medium">
              Approximate window
              <input
                type="text"
                value={approxWindow}
                onChange={(e) => setApproxWindow(e.target.value)}
                placeholder="mid-August"
                maxLength={120}
                className={fieldClass}
              />
              <span className="mt-1 block text-xs font-normal text-mist-400">
                A rough idea in the customer&apos;s words.
              </span>
            </label>
            <label className="block text-sm font-medium">
              Target month
              <input
                type="month"
                value={approxMonth}
                onChange={(e) => setApproxMonth(e.target.value)}
                className={fieldClass}
              />
            </label>
            <label className="block text-sm font-medium">
              Provisional date
              <input
                type="date"
                value={provisionalDate}
                onChange={(e) => setProvisionalDate(e.target.value)}
                className={fieldClass}
              />
              <span className="mt-1 block text-xs font-normal text-mist-400">
                A guessed specific date. It stays off the diary until the 25% confirms it.
              </span>
            </label>
          </div>

          {/* Property */}
          <div>
            <p className="eyebrow mb-2">Property</p>
            <div className="inline-flex w-fit gap-1 rounded-lg border border-border bg-card p-1">
              {PROPERTY_OPTIONS.map((opt) => (
                <button
                  key={opt.value || "unset"}
                  type="button"
                  aria-pressed={propertyType === opt.value}
                  onClick={() => setPropertyType(opt.value)}
                  className={cn(
                    "focus-ring rounded-md px-3 py-1.5 text-sm font-semibold transition-colors",
                    propertyType === opt.value ? "bg-foreground text-card" : "text-mist-500 hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-mist-400">
              {PROPERTY_OPTIONS.find((o) => o.value === propertyType)?.hint}
            </p>
          </div>

          {/* Read-only payment/requirement context */}
          {hasContext ? (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {context?.requiredVans != null ? (
                  <ContextChip>
                    <Truck className="size-3" strokeWidth={1.75} />
                    <span className="tabular">{context.requiredVans}</span> vans
                  </ContextChip>
                ) : null}
                {context?.requiredCrew != null ? (
                  <ContextChip>
                    <UsersRound className="size-3" strokeWidth={1.75} />
                    <span className="tabular">{context.requiredCrew}</span> crew
                  </ContextChip>
                ) : null}
                {context?.depositPaid !== undefined ? (
                  <ContextChip tone={context.depositPaid ? "on" : undefined}>
                    £100 {context.depositPaid ? "paid" : "unpaid"}
                  </ContextChip>
                ) : null}
                {context?.commitmentPaid !== undefined ? (
                  <ContextChip tone={context.commitmentPaid ? "on" : undefined}>
                    25% {context.commitmentPaid ? "paid" : "unpaid"}
                  </ContextChip>
                ) : null}
              </div>
              <p className="mt-1.5 text-[11px] text-mist-400">
                Payments are managed in the quote and bookings flow.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending} className="bg-mm-red text-white hover:bg-mm-red-deep">
            {pending ? (
              <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
            ) : (
              <CalendarClock className="size-4" strokeWidth={1.75} />
            )}
            Save move window
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Button + drawer in one — for server-rendered rows (Bookings page, lead
 * action bar) that just need "click here → drawer for this lead".
 */
export function BookingDetailsButton({
  leadId,
  leadName,
  initial,
  context,
  label = "Move window",
  className,
}: {
  leadId: string;
  leadName: string;
  initial: BookingDetailsInitial;
  context?: BookingDetailsContext | null;
  label?: string;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        }
      >
        <CalendarClock className="size-4 text-mist-400" strokeWidth={1.75} />
        {label}
      </button>
      <BookingDetailsDialog
        leadId={leadId}
        leadName={leadName}
        initial={initial}
        context={context}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
