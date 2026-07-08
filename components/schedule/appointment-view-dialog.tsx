"use client";

/**
 * View-first appointment modal — clicking a calendar item opens THIS, not the
 * edit form. Shows who/where/when read-only, the route from base on a Google
 * map (keyless embed) with distance/drive-time pills, and one-tap actions:
 * Call / WhatsApp / Message (internal comms dialog, not mailto) / Edit /
 * Mark done / Cancel visit / Delete. Built tablet-first: 44px targets.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, MessageCircle, MessageSquare, Pencil, FileText, CheckCircle2, Ban, Loader2, Clock, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CommsDialog } from "@/components/comms/comms-dialog";
import { updateAppointment } from "@/app/(dashboard)/schedule/actions";
import { LeadContextPanels, type EditTarget, type LeadOption } from "./appointment-dialog";

function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("0")) d = "44" + d.slice(1);
  return d.length >= 10 ? d : null;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  scheduled: { label: "Scheduled", cls: "bg-[#eff6ff] text-[#2563eb]" },
  completed: { label: "Completed", cls: "bg-[#ecfdf5] text-[#16a34a]" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-mist-400" },
};

export function AppointmentViewDialog({
  open,
  onOpenChange,
  target,
  lead,
  estimatorName,
  baseLocation,
  onEdit,
  onReschedule,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  target: EditTarget | null;
  lead: LeadOption | null;
  estimatorName: string | null;
  baseLocation: string;
  onEdit: () => void;
  onReschedule: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState<"loading" | "error" | { miles: number; durationText: string | null }>("loading");

  const dest = target?.location || lead?.from_address || lead?.from_postcode || null;

  // Distance + drive time from base — same pattern as the Clients map dialog.
  // `route` is deliberately NOT a dependency (setting "loading" must not cancel the fetch).
  useEffect(() => {
    if (!open || !dest) return;
    let cancelled = false;
    setRoute("loading");
    fetch(`/api/maps/route-to?dest=${encodeURIComponent(dest)}`)
      .then((r) => r.json())
      .then((d: { ok: boolean; miles?: number; durationText?: string | null }) => {
        if (cancelled) return;
        setRoute(d.ok && d.miles != null ? { miles: d.miles, durationText: d.durationText ?? null } : "error");
      })
      .catch(() => !cancelled && setRoute("error"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dest]);

  if (!target) return null;

  const when = target.startsAt ? new Date(target.startsAt) : null;
  const whenLabel = when
    ? `${when.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
    : "—";
  const badge = STATUS_BADGE[target.status ?? "scheduled"] ?? STATUS_BADGE.scheduled;
  const wa = waNumber(lead?.phone);
  // Anchor the embed's origin to the base POSTCODE — the keyless embed fuzzy-matches
  // house names ("Ash Cottage" exists all over Dorset); a postcode geocodes exactly.
  const origin = baseLocation.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i)?.[0] ?? baseLocation;
  const embedSrc = dest
    ? `https://www.google.com/maps?saddr=${encodeURIComponent(origin)}&daddr=${encodeURIComponent(dest)}&output=embed`
    : null;

  async function setStatus(status: "completed" | "cancelled", doneMsg: string) {
    if (!target) return;
    setBusy(true);
    try {
      const r = await updateAppointment(target.id, { status });
      if (!r.ok) {
        toast.error(r.error || "Could not update.");
        return;
      }
      toast.success(doneMsg);
      onOpenChange(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onCancelAppointment() {
    if (!target) return;
    if (!confirm("Cancel this appointment? It will be removed from the diary (the lead keeps its history).")) return;
    await setStatus("cancelled", "Appointment cancelled and removed from the diary.");
  }

  /** The estimator quotes from the visit — providing the quote IS attending it. */
  async function onQuote() {
    if (!target || !lead) return;
    setBusy(true);
    try {
      if (target.status === "scheduled") {
        const r = await updateAppointment(target.id, { status: "completed" });
        if (!r.ok) {
          toast.error(r.error || "Could not mark the visit attended.");
          return;
        }
      }
      onOpenChange(false);
      router.push(`/quotes/new?leadId=${lead.id}`);
    } finally {
      setBusy(false);
    }
  }

  const actionBtn =
    "focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-muted";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="font-display flex flex-wrap items-center gap-2 pr-6">
            {target.title || (target.apptType === "removal" ? "Removal" : "Survey")}
            <span className={cn("rounded-pill px-2 py-0.5 text-xs font-medium", badge.cls)}>{badge.label}</span>
            <button
              type="button"
              onClick={onEdit}
              className="focus-ring inline-flex min-h-8 items-center gap-1 rounded-md border border-input bg-card px-2.5 text-xs font-medium text-mist-500 hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-3.5" strokeWidth={1.75} />
              Edit
            </button>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" strokeWidth={1.75} />
              {whenLabel}
            </span>
            {estimatorName ? <span>Estimator: {estimatorName}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* quick contact actions — one row, equal widths */}
          {lead ? (
            <div className="flex gap-2">
              {lead.phone ? (
                <a href={`tel:${lead.phone}`} className={cn(actionBtn, "min-w-0 flex-1")}>
                  <Phone className="size-4 shrink-0 text-[#16a34a]" strokeWidth={1.75} />
                  Call
                </a>
              ) : null}
              {wa ? (
                <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className={cn(actionBtn, "min-w-0 flex-1")}>
                  <MessageCircle className="size-4 shrink-0 text-[#16a34a]" strokeWidth={1.75} />
                  WhatsApp
                </a>
              ) : null}
              <CommsDialog
                leadId={lead.id}
                defaultEmail={lead.email ?? undefined}
                defaultPhone={lead.phone ?? undefined}
                trigger={
                  <button type="button" className={cn(actionBtn, "min-w-0 flex-1")}>
                    <MessageSquare className="size-4 shrink-0 text-[#2563eb]" strokeWidth={1.75} />
                    Message
                  </button>
                }
              />
            </div>
          ) : null}

          {lead ? <LeadContextPanels lead={lead} /> : null}

          {/* route from base — map + distance/time */}
          {embedSrc ? (
            <div className="overflow-hidden rounded-md border border-border">
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
                <p className="text-[11px] font-bold tracking-[0.14em] text-mist-400 uppercase">Route from base</p>
                <div className="ml-auto flex items-center gap-1.5">
                  {route === "loading" ? (
                    <span className="text-xs text-mist-400">Working out the route…</span>
                  ) : route === "error" ? (
                    <span className="text-xs text-mist-400">Distance unavailable</span>
                  ) : (
                    <>
                      <span className="rounded-pill bg-mm-red-tint px-2 py-0.5 text-xs font-semibold tabular text-mm-red-deep">
                        {route.miles} mi
                      </span>
                      {route.durationText ? (
                        <span className="rounded-pill bg-muted px-2 py-0.5 text-xs font-medium tabular text-mist-500">
                          {route.durationText}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              <iframe
                title={`Route to ${dest}`}
                src={embedSrc}
                className="h-56 w-full sm:h-64"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          ) : null}

          {target.notes ? <p className="text-sm text-mist-500">{target.notes}</p> : null}

          {/* visit outcome — quoting IS attending; Mark done covers no-quote visits */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {lead && target.apptType === "survey" ? (
              <Button type="button" onClick={onQuote} disabled={busy} className="h-11">
                {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <FileText className="size-4" strokeWidth={1.75} />}
                Quote
              </Button>
            ) : null}
            {target.status !== "completed" ? (
              <Button type="button" variant="ghost" onClick={() => setStatus("completed", "Visit marked completed.")} disabled={busy} className="h-11 text-success hover:bg-success-bg hover:text-success">
                <CheckCircle2 className="size-4" strokeWidth={1.75} />
                Mark done
              </Button>
            ) : null}
            {target.status === "scheduled" ? (
              <Button type="button" variant="ghost" onClick={onReschedule} disabled={busy} className="h-11 text-mist-500 hover:text-foreground">
                <CalendarClock className="size-4" strokeWidth={1.75} />
                Reschedule
              </Button>
            ) : null}
            {target.status === "scheduled" ? (
              <Button type="button" variant="ghost" onClick={onCancelAppointment} disabled={busy} className="text-mm-red hover:text-mm-red hover:bg-mm-red-tint ml-auto h-11">
                <Ban className="size-4" strokeWidth={1.75} />
                Cancel appointment
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
