"use client";

/**
 * Create / edit / delete an appointment (survey or removal).
 * - Create mode: createAppointment({...}). Booking a survey linked to a lead
 *   auto-sets that lead -> survey_booked server-side (no client work here).
 * - Edit mode: updateAppointment(id, {...}) + a Delete button (deleteAppointment).
 * Reschedule of start/end on an existing appt also routes through
 * rescheduleAppointment so the calendar stays the source of truth for timing.
 *
 * datetime-local inputs are read as wall-clock and converted to ISO for the
 * server actions.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2, Phone, Mail, User, Home, ArrowRight, StickyNote } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LeadCombobox } from "@/components/schedule/lead-combobox";
import { SOURCES, type SourceKey } from "@/lib/dashboard/compute";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createAppointment,
  updateAppointment,
  deleteAppointment,
  rescheduleAppointment,
} from "@/app/(dashboard)/schedule/actions";

export type ApptType = "survey" | "removal";

export interface LeadOption {
  id: string;
  name: string | null;
  phone?: string | null;
  email?: string | null;
  from_postcode?: string | null;
  from_address?: string | null;
  to_postcode?: string | null;
  to_address?: string | null;
  property_size?: string | null;
  lead_notes?: string | null;
  /** Where the lead came from (classified) — shown so the estimator has full context. */
  source?: SourceKey | null;
  /** Estimator from this lead's booked survey — a removal inherits it (read-only). */
  surveyEstimatorId?: string | null;
  /** A bare client (no enquiry yet) — picking them opens the enquiry server-side. */
  isClient?: boolean;
}

/** Surveys are a fixed 1-hour visit. */
const SURVEY_HOURS = 1;

export interface EstimatorOption {
  id: string;
  full_name: string;
}

export interface EditTarget {
  id: string;
  apptType: ApptType;
  leadId: string | null;
  estimatorId: string | null;
  status: string | null;
  title: string | null;
  location: string | null;
  notes: string | null;
  startsAt: string; // ISO
  endsAt: string; // ISO
}

const NO_LEAD = "__none__";
const NO_EST = "__none__";

/** Convert an ISO (or Date) into a value for <input type="datetime-local"> in local wall-clock. */
function toLocalInput(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** datetime-local string -> ISO. */
function localToIso(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

/** add hours to a datetime-local string, returning a datetime-local string. */
function addHoursLocal(local: string, hours: number): string {
  if (!local) return "";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "";
  d.setHours(d.getHours() + hours);
  return toLocalInput(d);
}

function defaultDuration(type: ApptType): number {
  return type === "removal" ? 3 : 1;
}

/** Read-only context panels for the selected lead: who the customer is + what the
 *  move is. Tap-to-call / tap-to-email (44px targets — this runs on phones/tablets).
 *  Shared with the view-first appointment modal. */
export function LeadContextPanels({ lead }: { lead: LeadOption }) {
  // Address + postcode together — the postcode is what the crew navigates by.
  const addrLines = (addr: string | null | undefined, pc: string | null | undefined): string[] => {
    const a = (addr || "").trim();
    const p = (pc || "").trim();
    const joined = a && p ? (a.toUpperCase().includes(p.toUpperCase()) ? a : `${a}, ${p}`) : a || p;
    // One line per comma-separated part — street / town / postcode stack vertically.
    return joined
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const from = addrLines(lead.from_address, lead.from_postcode);
  const to = addrLines(lead.to_address, lead.to_postcode);
  const srcMeta = lead.source ? SOURCES.find((s) => s.key === lead.source) ?? null : null;
  const AddrBlock = ({ lines }: { lines: string[] }) =>
    lines.length === 0 ? (
      <span className="text-mist-400">—</span>
    ) : (
      <span className="min-w-0">
        {lines.map((l, i) => (
          <span key={i} className="block truncate">
            {l}
          </span>
        ))}
      </span>
    );
  return (
    <div className="grid gap-3 sm:grid-cols-[3fr_4fr_3fr]">
      {/* Customer */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] text-mist-400 uppercase">
          <User className="size-3.5" strokeWidth={2} />
          Customer
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-foreground">{lead.name ?? "—"}</p>
          {srcMeta ? (
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-card px-2 py-0.5 text-xs font-medium text-mist-500 ring-1 ring-border">
              <span className="size-2 rounded-full" style={{ background: srcMeta.color }} />
              {srcMeta.label}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-col items-start">
          {lead.phone ? (
            <a
              href={`tel:${lead.phone}`}
              className="focus-ring -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Phone className="size-4 shrink-0 text-[#16a34a]" strokeWidth={1.75} />
              {lead.phone}
            </a>
          ) : null}
          {lead.email ? (
            <a
              href={`mailto:${lead.email}`}
              className="focus-ring -ml-2 inline-flex min-h-11 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Mail className="size-4 shrink-0 text-mm-red" strokeWidth={1.75} />
              <span className="truncate">{lead.email}</span>
            </a>
          ) : null}
          {!lead.phone && !lead.email ? <p className="text-sm text-mist-400">No contact details on the lead.</p> : null}
        </div>
      </div>

      {/* Move */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] text-mist-400 uppercase">
          <Home className="size-3.5" strokeWidth={2} />
          Move
        </p>
        <div className="flex items-start gap-2 text-sm text-foreground">
          <AddrBlock lines={from} />
          <ArrowRight className="mt-0.5 size-4 shrink-0 text-mm-red" strokeWidth={2} />
          <AddrBlock lines={to} />
        </div>
        {lead.property_size ? <p className="mt-1.5 text-xs font-medium text-[#16a34a]">{lead.property_size}</p> : null}
      </div>

      {/* Notes */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] text-mist-400 uppercase">
          <StickyNote className="size-3.5" strokeWidth={2} />
          Notes
        </p>
        {lead.lead_notes ? (
          <p className="max-h-28 overflow-y-auto text-sm whitespace-pre-wrap text-foreground">{lead.lead_notes}</p>
        ) : (
          <p className="text-sm text-mist-400">No notes on the lead.</p>
        )}
      </div>
    </div>
  );
}

/** Round a time up to the next 15-minute boundary (keeps "now" defaults on-grid). */
function roundUpTo15(d: Date): Date {
  const r = new Date(d);
  r.setSeconds(0, 0);
  const add = (15 - (r.getMinutes() % 15)) % 15;
  if (add) r.setMinutes(r.getMinutes() + add);
  return r;
}

export function AppointmentDialog({
  open,
  onOpenChange,
  leads,
  estimators,
  defaultEstimatorId,
  defaultType,
  presetStart,
  presetEnd,
  presetAllDay,
  presetLeadId,
  presetLocation,
  edit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  leads: LeadOption[];
  estimators: EstimatorOption[];
  /** current user — the default estimator for a new appointment */
  defaultEstimatorId?: string | null;
  /** the view's natural type — used to preset the type selector in create mode */
  defaultType: ApptType;
  /** datetime-local strings to prefill (from dateClick/select) */
  presetStart?: string;
  presetEnd?: string;
  presetAllDay?: boolean;
  /** booked from a lead: preselect the lead + its address as the location */
  presetLeadId?: string;
  presetLocation?: string;
  /** when set, the dialog is in edit mode */
  edit?: EditTarget | null;
}) {
  const router = useRouter();
  const isEdit = !!edit;
  // The type is decided by the surface (Surveys page books surveys, Removals page
  // books removals) — never a form choice.
  const apptType: ApptType = edit?.apptType ?? defaultType;

  const [leadId, setLeadId] = useState<string>(NO_LEAD);
  const [estimatorId, setEstimatorId] = useState<string>(NO_EST);
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [allDay, setAllDay] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  // (Re)seed the form whenever the dialog opens or its target changes.
  useEffect(() => {
    if (!open) return;
    if (edit) {
      setLeadId(edit.leadId ?? NO_LEAD);
      setEstimatorId(edit.estimatorId ?? NO_EST);
      setStart(toLocalInput(edit.startsAt));
      setEnd(toLocalInput(edit.endsAt));
      setNotes(edit.notes ?? "");
      setAllDay(false);
    } else {
      const s = presetStart ?? toLocalInput(roundUpTo15(new Date()));
      setLeadId(presetLeadId ?? NO_LEAD);
      // Surveys default the estimator to the booker; removals inherit it from the
      // lead's survey (read-only), so they never seed the current user.
      const presetLead = presetLeadId ? leads.find((l) => l.id === presetLeadId) : null;
      setEstimatorId(
        defaultType === "removal" ? presetLead?.surveyEstimatorId ?? NO_EST : defaultEstimatorId ?? NO_EST,
      );
      setStart(s);
      setEnd(presetEnd ?? addHoursLocal(s, defaultDuration(defaultType)));
      setNotes("");
      setAllDay(!!presetAllDay);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, edit?.id]);

  // Keep end ahead of start in create mode when start moves.
  function onStartChange(v: string) {
    setStart(v);
    if (!isEdit && v && (!end || new Date(end) <= new Date(v))) {
      setEnd(addHoursLocal(v, defaultDuration(apptType)));
    }
  }

  const estimatorName = (id: string) =>
    id === NO_EST ? null : estimators.find((e) => e.id === id)?.full_name ?? null;

  // A removal's estimator is the survey's — inherited, never chosen here.
  function inheritSurveyEstimator(leadIdVal: string) {
    const l = leadIdVal === NO_LEAD ? null : leads.find((x) => x.id === leadIdVal);
    setEstimatorId(l?.surveyEstimatorId ?? NO_EST);
  }

  // Surveys are a fixed 1-hour visit (no end field — just a label). Removals use
  // the editable end. Derive the effective end the same way for both submit paths.
  const effectiveEnd = apptType === "survey" ? addHoursLocal(start, SURVEY_HOURS) : end;
  const surveyEndLabel = start ? addHoursLocal(start, SURVEY_HOURS).slice(11, 16) : "";

  function selectLead(id: string) {
    setLeadId(id);
    // A removal inherits the chosen lead's survey estimator (read-only).
    if (apptType === "removal" && !isEdit) inheritSurveyEstimator(id);
  }

  async function onSubmit() {
    if (!start) {
      toast.error("Pick a start time.");
      return;
    }
    const endLocal = effectiveEnd;
    if (!endLocal || new Date(endLocal) <= new Date(start)) {
      toast.error("End must be after start.");
      return;
    }
    setBusy(true);
    try {
      const selected = leadId === NO_LEAD ? null : leads.find((l) => l.id === leadId) ?? null;
      // A bare client has no enquiry yet — the server opens one when booking.
      const lead = selected && !selected.isClient ? selected.id : null;
      const clientId = selected?.isClient ? selected.id : null;
      const startsAt = localToIso(start);
      const endsAt = localToIso(endLocal);

      if (isEdit && edit) {
        // Persist the editable metadata. Title/location/status are managed elsewhere
        // (system title, lead address, view-modal actions) — never patched here.
        const meta = await updateAppointment(edit.id, {
          notes,
          estimatorId: estimatorId === NO_EST ? null : estimatorId,
        });
        if (!meta.ok) {
          toast.error(meta.error || "Could not save appointment.");
          return;
        }
        // If timing changed, route it through the reschedule action.
        if (startsAt !== edit.startsAt || endsAt !== edit.endsAt) {
          const r = await rescheduleAppointment(edit.id, startsAt, endsAt);
          if (!r.ok) {
            toast.error(r.error || "Could not update the time.");
            return;
          }
        }
        toast.success("Appointment updated.");
      } else {
        const res = await createAppointment({
          apptType,
          leadId: lead,
          clientId,
          estimatorId: estimatorId === NO_EST ? null : estimatorId,
          startsAt,
          endsAt,
          // location intentionally omitted — the server derives it from the lead's
          // pickup address (the survey happens where the move starts).
          notes: notes.trim() || undefined,
          allDay,
        });
        if (!res.ok) {
          toast.error(res.error || "Could not create appointment.");
          return;
        }
        if (apptType === "survey" && "comms" in res && res.comms) {
          const { email, sms } = res.comms;
          const sent = [email === "sent" ? "email" : null, sms === "sent" ? "SMS" : null].filter(Boolean);
          const failed = [email === "failed" ? "email" : null, sms === "failed" ? "SMS" : null].filter(Boolean);
          if (sent.length) toast.success(`Survey booked — confirmation ${sent.join(" + ")} sent to the customer.`);
          else toast.success("Survey booked.");
          if (failed.length) toast.error(`Confirmation ${failed.join(" + ")} failed — send it from the lead's Comms tab.`);
        } else {
          toast.success(apptType === "survey" ? "Survey booked." : "Removal scheduled.");
        }
      }
      onOpenChange(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!edit) return;
    if (!confirm("Delete this appointment? This cannot be undone.")) return;
    setBusy(true);
    try {
      const r = await deleteAppointment(edit.id);
      if (!r.ok) {
        toast.error(("error" in r && r.error) || "Could not delete.");
        return;
      }
      toast.success("Appointment deleted.");
      onOpenChange(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Never close on outside interaction: fixes the phantom close after using a
          Select inside the dialog (its portal makes the next click read as "outside"),
          and stops accidental backdrop-taps losing a half-filled booking on tablets. */}
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="font-display">
            {isEdit ? `Edit ${apptType}` : apptType === "survey" ? "Book a survey" : "Book a removal"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Change the estimator, time or notes. The visit happens at the customer's pickup address."
              : "Pick the customer and time — the visit address comes from their move."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          {/* Who + what this visit is about — read-only context for the chosen lead. */}
          {leadId !== NO_LEAD && leads.find((l) => l.id === leadId) ? (
            <LeadContextPanels lead={leads.find((l) => l.id === leadId)!} />
          ) : null}

          {/* The customer is fixed once booked — pick only when creating. */}
          {!isEdit ? (
            <div className="grid gap-2">
              <Label htmlFor="appt-lead">
                Lead / customer <span className="text-mist-400 font-normal">(optional)</span>
              </Label>
              <LeadCombobox leads={leads} value={leadId} onChange={selectLead} />
            </div>
          ) : null}

          <div className={cn("grid gap-3", apptType === "removal" ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
            <div className="grid gap-2">
              <Label htmlFor="appt-estimator">Estimator</Label>
              {apptType === "removal" ? (
                <div className="flex h-9 items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-mist-500">
                  {estimatorName(estimatorId) ?? "From the survey"}
                </div>
              ) : (
                <Select value={estimatorId} onValueChange={setEstimatorId}>
                  <SelectTrigger id="appt-estimator">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_EST}>Unassigned</SelectItem>
                    {estimators.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="appt-start">Starts</Label>
              <Input id="appt-start" type="datetime-local" step={900} value={start} onChange={(e) => onStartChange(e.target.value)} />
            </div>
            {apptType === "removal" ? (
              <div className="grid gap-2">
                <Label htmlFor="appt-end">Ends</Label>
                <Input id="appt-end" type="datetime-local" step={900} value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            ) : null}
          </div>
          {apptType === "survey" ? (
            <p className="-mt-2 text-xs text-mist-400">
              Surveys are 1 hour{surveyEndLabel ? ` — ends ${surveyEndLabel}` : ""}. Who does the visit drives their pay + win stats.
            </p>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="appt-notes">Notes</Label>
            <textarea
              id="appt-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="border-input placeholder:text-mist-400 focus-visible:border-ring focus-visible:ring-ring/50 flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
              placeholder="Anything the crew needs to know"
            />
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          {isEdit ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onDelete}
              disabled={busy}
              className="text-mm-red hover:text-mm-red hover:bg-mm-red-tint h-11"
            >
              <Trash2 className="size-4" strokeWidth={1.75} />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="h-11"
            >
              Cancel
            </Button>
            <Button type="button" onClick={onSubmit} disabled={busy} className="h-11">
              {busy ? (
                <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
              ) : null}
              {isEdit ? "Save" : "Book"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
