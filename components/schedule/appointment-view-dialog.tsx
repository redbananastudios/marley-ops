"use client";

/**
 * View-first appointment modal — clicking a calendar item opens THIS, not the
 * edit form. Shows who/where/when read-only, the route from base on a Google
 * map (keyless embed) with distance/drive-time pills, and one-tap actions:
 * Call / WhatsApp / Message (internal comms dialog, not mailto) / Edit /
 * Mark done / Cancel visit / Delete. Built tablet-first: 44px targets.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, MessageCircle, MessageSquare, Pencil, FileText, Ban, Loader2, Clock, CalendarClock, MapPin } from "lucide-react";
import { toast } from "sonner";
import { reportSurveySend, duplicateWarning } from "@/lib/comms/survey-send-report";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ignorePortalInteractOutside,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CommsDialog } from "@/components/comms/comms-dialog";
import { BalanceInvoiceButton } from "@/components/leads/balance-invoice-button";
import { JobSummary } from "@/components/schedule/job-summary";
import { updateAppointment } from "@/app/(dashboard)/schedule/actions";
import { liveQuoteForLead } from "@/app/(dashboard)/quotes/actions";
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
  // Which journey the map shows: the JOB (pickup -> destination, the default —
  // that's the move being quoted) or TO PICKUP (base -> pickup, the drive out).
  const [routeMode, setRouteMode] = useState<"job" | "pickup">("job");
  // Nothing is fetched until the user asks for it — a leg becomes "activated" by
  // tapping the map placeholder or switching to its tab. Once fetched/rendered it
  // stays cached (and its iframe stays mounted) so switching back costs nothing.
  const [activated, setActivated] = useState<{ job: boolean; pickup: boolean }>({ job: false, pickup: false });
  const [routes, setRoutes] = useState<
    Partial<Record<"job" | "pickup", "loading" | "error" | { miles: number; durationText: string | null }>>
  >({});
  // Bumped when a different appointment opens so late fetch results for the old
  // one can't write into the new one's cache.
  const routeReq = useRef(0);

  const pickupFull =
    [lead?.from_address, lead?.from_postcode].filter(Boolean).join(", ") ||
    target?.location ||
    null;
  const destFull = [lead?.to_address, lead?.to_postcode].filter(Boolean).join(", ") || null;
  const hasJobRoute = !!(pickupFull && destFull);
  // Anchor the base origin to its POSTCODE — the keyless embed fuzzy-matches house
  // names ("Ash Cottage" exists all over Dorset); a postcode geocodes exactly.
  const basePc = baseLocation.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i)?.[0] ?? baseLocation;

  const LEGS = {
    job: { origin: pickupFull, dest: destFull, embedOrigin: pickupFull },
    pickup: { origin: null, dest: pickupFull, embedOrigin: basePc }, // null origin -> API defaults to base
  } as const;
  const embedFor = (mode: "job" | "pickup") => {
    const l = LEGS[mode];
    return l.embedOrigin && l.dest
      ? `https://www.google.com/maps?saddr=${encodeURIComponent(l.embedOrigin)}&daddr=${encodeURIComponent(l.dest)}&output=embed`
      : null;
  };

  // Reset to the job view + clear the leg cache each time a new appointment opens.
  useEffect(() => {
    if (open) {
      setRouteMode(hasJobRoute ? "job" : "pickup");
      setActivated({ job: false, pickup: false });
      setRoutes({});
      routeReq.current++;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.id]);

  // Distance + drive time for the shown leg — fetched once per leg, on demand.
  // `routes` is deliberately NOT a dependency (setting "loading" must not refire);
  // no cancel-on-mode-switch either, so an in-flight leg still lands in the cache.
  useEffect(() => {
    if (!open || !activated[routeMode] || routes[routeMode] !== undefined) return;
    const mode = routeMode;
    const leg = LEGS[mode];
    if (!leg.dest) return;
    const token = routeReq.current;
    setRoutes((r) => ({ ...r, [mode]: "loading" }));
    const qs = `dest=${encodeURIComponent(leg.dest)}${leg.origin ? `&origin=${encodeURIComponent(leg.origin)}` : ""}`;
    fetch(`/api/maps/route-to?${qs}`)
      .then((r) => r.json())
      .then((d: { ok: boolean; miles?: number; durationText?: string | null }) => {
        if (token !== routeReq.current) return;
        setRoutes((r) => ({
          ...r,
          [mode]: d.ok && d.miles != null ? { miles: d.miles, durationText: d.durationText ?? null } : "error",
        }));
      })
      .catch(() => {
        if (token === routeReq.current) setRoutes((r) => ({ ...r, [mode]: "error" }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, routeMode, activated]);

  if (!target) return null;

  const when = target.startsAt ? new Date(target.startsAt) : null;
  const whenLabel = when
    ? `${when.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
    : "—";
  const badge = STATUS_BADGE[target.status ?? "scheduled"] ?? STATUS_BADGE.scheduled;
  const wa = waNumber(lead?.phone);
  const route = routes[routeMode];

  async function setStatus(status: "completed" | "cancelled", doneMsg: string, notifyCustomer?: boolean) {
    if (!target) return;
    setBusy(true);
    try {
      const r = await updateAppointment(target.id, { status }, { notifyCustomer });
      if (!r.ok) {
        toast.error(r.error || "Could not update.");
        return;
      }
      const rep = "comms" in r && r.comms ? reportSurveySend(r.comms) : null;
      toast.success(rep?.sent ? `${doneMsg} Customer told by ${rep.sent}.` : doneMsg);
      if (rep?.duplicate) toast.warning(duplicateWarning(rep.duplicate));
      if (rep?.failed) {
        toast.error(`Could not tell the customer by ${rep.failed} — call them so they don't wait in.`);
      }
      onOpenChange(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onCancelAppointment() {
    if (!target) return;
    if (!confirm("Cancel this appointment? It will be removed from the diary (the lead keeps its history).")) return;
    // A cancelled survey is the one the customer MUST hear about — they are
    // holding a confirmation saying someone is coming to their house. Ask
    // rather than assume, same rule as the booking and reschedule dialogs.
    let notifyCustomer: boolean | undefined;
    if (target.apptType === "survey" && (lead?.email || lead?.phone)) {
      notifyCustomer = confirm(
        `Let ${lead?.name || "the customer"} know the visit is cancelled, so they don't wait in?\n\nOK sends it. Cancel keeps it silent.`,
      );
    }
    await setStatus("cancelled", "Appointment cancelled and removed from the diary.", notifyCustomer);
  }

  /** The estimator quotes from the visit — providing the quote IS attending it. */
  async function onQuote() {
    if (!target || !lead) return;
    setBusy(true);
    try {
      // The quote may already exist: some jobs are priced over the phone and the
      // visit only confirms it (Peter, 2026-08-10). Opening a blank builder there
      // discards the pricing already done and risks a second quote reaching a
      // customer who is holding the first, so offer the existing one first.
      const existing = await liveQuoteForLead(lead.id);
      const openExisting =
        existing != null &&
        confirm(
          `${lead.name || "This customer"} already has quote ${existing.quoteRef}.\n\nOK opens it to update. Cancel starts a new quote instead.`,
        );
      if (target.status === "scheduled") {
        const r = await updateAppointment(target.id, { status: "completed" });
        if (!r.ok) {
          toast.error(r.error || "Could not mark the visit attended.");
          return;
        }
      }
      onOpenChange(false);
      router.push(openExisting && existing ? `/quotes/${existing.id}` : `/quotes/new?leadId=${lead.id}`);
    } finally {
      setBusy(false);
    }
  }

  const actionBtn =
    "focus-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-muted";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92vh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-3xl lg:max-w-5xl"
        onInteractOutside={ignorePortalInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="font-display flex flex-wrap items-center gap-2 pr-6">
            {target.title || (target.apptType === "removal" ? "Removal" : target.apptType === "pack" ? "Packing" : "Survey")}
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
                  <Phone className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                  Call
                </a>
              ) : null}
              {wa ? (
                <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer" className={cn(actionBtn, "min-w-0 flex-1")}>
                  <MessageCircle className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                  WhatsApp
                </a>
              ) : null}
              <CommsDialog
                leadId={lead.id}
                defaultEmail={lead.email ?? undefined}
                defaultPhone={lead.phone ?? undefined}
                trigger={
                  <button type="button" className={cn(actionBtn, "min-w-0 flex-1")}>
                    <MessageSquare className="size-4 shrink-0 text-mist-400" strokeWidth={1.75} />
                    Message
                  </button>
                }
              />
            </div>
          ) : null}

          {lead ? <LeadContextPanels lead={lead} /> : null}

          {/* The move itself — what the crew bring, who's on it, access at both
              ends. Removals + packing days only; a survey has no job to brief. */}
          {target.apptType !== "survey" ? (
            <JobSummary appointmentId={target.id} apptNotes={target.notes} open={open} />
          ) : null}

          {/* map left (75%), action stack right (25%) */}
          <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-[3fr_1fr]">
            {/* route map — legs load on demand and stay cached once rendered */}
            {embedFor(routeMode) ? (
              <div className="overflow-hidden rounded-md border border-border">
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
                  {hasJobRoute ? (
                    <div className="inline-flex rounded-md border border-border bg-card p-0.5">
                      {(
                        [
                          { key: "job" as const, label: "Job route" },
                          { key: "pickup" as const, label: "To pickup" },
                        ]
                      ).map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => {
                            setRouteMode(m.key);
                            // Switching to a tab calculates that leg (first time only).
                            setActivated((a) => (a[m.key] ? a : { ...a, [m.key]: true }));
                          }}
                          aria-pressed={routeMode === m.key}
                          className={cn(
                            "focus-ring rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                            routeMode === m.key ? "bg-mm-red text-white" : "text-mist-400 hover:text-foreground",
                          )}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] font-bold tracking-[0.14em] text-mist-400 uppercase">Route from base</p>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {!activated[routeMode] ? null : route === "loading" || route === undefined ? (
                      <span className="text-xs text-mist-400">Working out the route…</span>
                    ) : route === "error" ? (
                      <span className="text-xs text-mist-400">Distance unavailable</span>
                    ) : (
                      <>
                        <span className="rounded-pill bg-mm-red px-2 py-0.5 text-xs font-semibold tabular text-white">
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
                <div className="relative h-56 w-full sm:h-72 lg:h-80">
                  {(["job", "pickup"] as const).map((m) => {
                    const src = activated[m] ? embedFor(m) : null;
                    return src ? (
                      <iframe
                        key={m}
                        title={m === "job" ? "Job route" : "Route to pickup"}
                        src={src}
                        className={cn("absolute inset-0 h-full w-full", routeMode === m ? "" : "hidden")}
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                      />
                    ) : null;
                  })}
                  {!activated[routeMode] ? (
                    <button
                      type="button"
                      onClick={() => setActivated((a) => ({ ...a, [routeMode]: true }))}
                      className="focus-ring absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/40 text-sm font-medium text-mist-500 hover:bg-muted/60"
                    >
                      <MapPin className="size-6 text-mm-red" strokeWidth={1.5} />
                      Tap to calculate route
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div />
            )}

            {/* action stack — Quote is THE outcome (it marks the visit attended);
                a full button-height gap below it guards against mis-taps. */}
            <div className="flex flex-col gap-2">
              {lead && target.apptType === "survey" ? (
                <>
                  <Button type="button" onClick={onQuote} disabled={busy} className="h-12 w-full text-base">
                    {busy ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : <FileText className="size-4" strokeWidth={1.75} />}
                    Create Quote
                  </Button>
                  <div aria-hidden className="h-11" />
                </>
              ) : null}
              {lead && target.apptType === "removal" ? (
                <>
                  {/* Payment in full is due BEFORE the job — trigger the balance
                      invoice from the diary the day before (or sooner). */}
                  <BalanceInvoiceButton leadId={lead.id} size="default" variant="default" className="h-12 w-full text-base" />
                  <div aria-hidden className="h-11" />
                </>
              ) : null}
              {target.status === "scheduled" ? (
                <Button type="button" variant="outline" onClick={onReschedule} disabled={busy} className="h-11 w-full">
                  <CalendarClock className="size-4" strokeWidth={1.75} />
                  Reschedule Appointment
                </Button>
              ) : null}
              {target.status === "scheduled" ? (
                <Button type="button" variant="outline" onClick={onCancelAppointment} disabled={busy} className="h-11 w-full text-mm-red hover:text-mm-red hover:bg-mm-red-tint">
                  <Ban className="size-4" strokeWidth={1.75} />
                  Cancel Appointment
                </Button>
              ) : null}
            </div>
          </div>

          {/* Survey visits keep their notes here (removals/packs carry them in
              the job summary above, labelled) — named so they can't be read as
              the lead's enquiry notes. */}
          {target.apptType === "survey" && target.notes ? (
            <p className="text-sm text-mist-500">
              <span className="font-semibold text-foreground">Job notes: </span>
              {target.notes}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
