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
import { Loader2, Trash2, CheckCircle2, Phone, Mail, User, Home, ArrowRight, StickyNote } from "lucide-react";
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
import {
  AddressFields,
  formatAddress,
  addressFromString,
  BLANK_ADDRESS,
  type AddressValue,
} from "@/components/places/address-fields";
import { LeadCombobox } from "@/components/schedule/lead-combobox";
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
  /** Estimator from this lead's booked survey — a removal inherits it (read-only). */
  surveyEstimatorId?: string | null;
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
 *  move is. Tap-to-call / tap-to-email (44px targets — this runs on phones/tablets). */
function LeadContextPanels({ lead }: { lead: LeadOption }) {
  const from = lead.from_address || lead.from_postcode;
  const to = lead.to_address || lead.to_postcode;
  return (
    <div className="grid gap-3 sm:grid-cols-2 md:col-span-2">
      {/* Customer */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] text-mist-400 uppercase">
          <User className="size-3.5" strokeWidth={2} />
          Customer
        </p>
        <p className="text-sm font-semibold text-foreground">{lead.name ?? "—"}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5">
          {lead.phone ? (
            <a
              href={`tel:${lead.phone}`}
              className="focus-ring -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-[#db2777] hover:bg-muted"
            >
              <Phone className="size-4" strokeWidth={1.75} />
              {lead.phone}
            </a>
          ) : null}
          {lead.email ? (
            <a
              href={`mailto:${lead.email}`}
              className="focus-ring -ml-2 inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-[#2563eb] hover:bg-muted sm:ml-0"
            >
              <Mail className="size-4 shrink-0" strokeWidth={1.75} />
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
          <span className="min-w-0 flex-1">{from ?? "—"}</span>
          <ArrowRight className="mt-0.5 size-4 shrink-0 text-mm-red" strokeWidth={2} />
          <span className="min-w-0 flex-1">{to ?? "—"}</span>
        </div>
        {lead.property_size ? <p className="mt-1.5 text-xs font-medium text-[#16a34a]">{lead.property_size}</p> : null}
        {lead.lead_notes ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-mist-500">
            <StickyNote className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="line-clamp-3">{lead.lead_notes}</span>
          </p>
        ) : null}
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

  const [apptType, setApptType] = useState<ApptType>(defaultType);
  const [leadId, setLeadId] = useState<string>(NO_LEAD);
  const [estimatorId, setEstimatorId] = useState<string>(NO_EST);
  const [status, setStatus] = useState<string>("scheduled");
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [address, setAddress] = useState<AddressValue>(BLANK_ADDRESS);
  const [notes, setNotes] = useState<string>("");
  const [allDay, setAllDay] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  // (Re)seed the form whenever the dialog opens or its target changes.
  useEffect(() => {
    if (!open) return;
    if (edit) {
      setApptType(edit.apptType);
      setLeadId(edit.leadId ?? NO_LEAD);
      setEstimatorId(edit.estimatorId ?? NO_EST);
      setStatus(edit.status ?? "scheduled");
      setStart(toLocalInput(edit.startsAt));
      setEnd(toLocalInput(edit.endsAt));
      setTitle(edit.title ?? "");
      setTitleTouched(true);
      setAddress(addressFromString(edit.location));
      setNotes(edit.notes ?? "");
      setAllDay(false);
    } else {
      const s = presetStart ?? toLocalInput(roundUpTo15(new Date()));
      setApptType(defaultType);
      setLeadId(presetLeadId ?? NO_LEAD);
      // Surveys default the estimator to the booker; removals inherit it from the
      // lead's survey (read-only), so they never seed the current user.
      const presetLead = presetLeadId ? leads.find((l) => l.id === presetLeadId) : null;
      setEstimatorId(
        defaultType === "removal" ? presetLead?.surveyEstimatorId ?? NO_EST : defaultEstimatorId ?? NO_EST,
      );
      setStatus("scheduled");
      setStart(s);
      setEnd(presetEnd ?? addHoursLocal(s, defaultDuration(defaultType)));
      setTitle("");
      setTitleTouched(false);
      setAddress(addressFromString(presetLocation ?? ""));
      setNotes("");
      setAllDay(!!presetAllDay);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, edit?.id]);

  // Auto-title from lead name + type, until the user types their own.
  useEffect(() => {
    if (titleTouched) return;
    const lead = leads.find((l) => l.id === leadId);
    const label = apptType === "survey" ? "Survey" : "Removal";
    setTitle(lead?.name ? `${label} — ${lead.name}` : label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, apptType, titleTouched]);

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

  // Switching type re-bases the end on the type's default duration.
  function onTypeChange(v: ApptType) {
    setApptType(v);
    if (start) setEnd(addHoursLocal(start, defaultDuration(v)));
    // Moving to a removal: pull the estimator from the lead's survey (read-only there).
    if (v === "removal" && !isEdit) inheritSurveyEstimator(leadId);
  }

  // Surveys are a fixed 1-hour visit (no end field — just a label). Removals use
  // the editable end. Derive the effective end the same way for both submit paths.
  const effectiveEnd = apptType === "survey" ? addHoursLocal(start, SURVEY_HOURS) : end;
  const surveyEndLabel = start ? addHoursLocal(start, SURVEY_HOURS).slice(11, 16) : "";

  // Picking a lead pre-fills the location with its address (unless already set).
  function selectLead(id: string) {
    setLeadId(id);
    if (id !== NO_LEAD && !formatAddress(address).trim()) {
      const l = leads.find((x) => x.id === id);
      const addr = l?.from_address || l?.from_postcode || "";
      if (addr) setAddress(addressFromString(addr));
    }
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
      const lead = leadId === NO_LEAD ? null : leadId;
      const startsAt = localToIso(start);
      const endsAt = localToIso(endLocal);

      if (isEdit && edit) {
        // Persist the editable metadata.
        const meta = await updateAppointment(edit.id, {
          title: title.trim() || undefined,
          location: formatAddress(address),
          notes,
          status,
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
          estimatorId: estimatorId === NO_EST ? null : estimatorId,
          startsAt,
          endsAt,
          title: title.trim() || undefined,
          location: formatAddress(address) || undefined,
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

  async function markCompleted() {
    if (!edit) return;
    setBusy(true);
    try {
      const r = await updateAppointment(edit.id, { status: "completed" });
      if (!r.ok) {
        toast.error(r.error || "Could not update.");
        return;
      }
      toast.success("Visit marked completed.");
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">
            {isEdit ? "Edit appointment" : "New appointment"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the details, move the time, or remove it."
              : "Book a survey or removal. Surveys linked to a lead move that lead to survey booked."}
          </DialogDescription>
        </DialogHeader>

        {/* Two columns on desktop so the form stays short enough to reach the buttons. */}
        <div className="grid gap-x-6 gap-y-4 py-1 md:grid-cols-2">
          {/* Who + what this visit is about — read-only context for the chosen lead. */}
          {leadId !== NO_LEAD && leads.find((l) => l.id === leadId) ? (
            <LeadContextPanels lead={leads.find((l) => l.id === leadId)!} />
          ) : null}

          {/* Left — the appointment details */}
          <div className="grid content-start gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="appt-type">Type</Label>
                <Select value={apptType} onValueChange={(v) => onTypeChange(v as ApptType)}>
                  <SelectTrigger id="appt-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="survey">Survey</SelectItem>
                    <SelectItem value="removal">Removal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
            </div>

            <div className="grid gap-2">
              <Label htmlFor="appt-lead">
                Lead / customer <span className="text-mist-400 font-normal">(optional)</span>
              </Label>
              <LeadCombobox leads={leads} value={leadId} onChange={selectLead} />
            </div>

            {isEdit ? (
              <div className="grid gap-2">
                <Label htmlFor="appt-status">Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id="appt-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="completed">Completed (attended)</SelectItem>
                    <SelectItem value="cancelled">Cancelled / no-show</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className={cn("grid gap-3", apptType === "removal" ? "grid-cols-2" : "grid-cols-1")}>
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
                Surveys are 1 hour{surveyEndLabel ? ` — ends ${surveyEndLabel}` : ""}.
              </p>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="appt-title">Title</Label>
              <Input
                id="appt-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleTouched(true);
                }}
                placeholder="Survey — Jane Smith"
              />
            </div>
          </div>

          {/* Right — location + notes */}
          <div className="grid content-start gap-4">
            <div className="grid gap-2">
              <Label>Location</Label>
              <AddressFields value={address} onChange={setAddress} idPrefix="appt-loc" />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="appt-notes">Notes</Label>
              <textarea
                id="appt-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="border-input placeholder:text-mist-400 focus-visible:border-ring focus-visible:ring-ring/50 flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
                placeholder="Anything the crew needs to know"
              />
            </div>
            <p className="text-xs text-mist-400">Who does this visit drives their pay + win stats.</p>
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          {isEdit ? (
            <div className="flex items-center gap-1">
              {status !== "completed" ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={markCompleted}
                  disabled={busy}
                  className="h-11 text-success hover:bg-success-bg hover:text-success"
                >
                  <CheckCircle2 className="size-4" strokeWidth={1.75} />
                  Mark done
                </Button>
              ) : null}
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
            </div>
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
