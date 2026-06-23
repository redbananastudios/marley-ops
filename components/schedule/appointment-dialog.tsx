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
import { Loader2, Trash2, CheckCircle2 } from "lucide-react";
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
}

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
  const [location, setLocation] = useState<string>("");
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
      setLocation(edit.location ?? "");
      setNotes(edit.notes ?? "");
      setAllDay(false);
    } else {
      const s = presetStart ?? toLocalInput(new Date());
      setApptType(defaultType);
      setLeadId(NO_LEAD);
      setEstimatorId(defaultEstimatorId ?? NO_EST);
      setStatus("scheduled");
      setStart(s);
      setEnd(presetEnd ?? addHoursLocal(s, defaultDuration(defaultType)));
      setTitle("");
      setTitleTouched(false);
      setLocation("");
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

  async function onSubmit() {
    if (!start || !end) {
      toast.error("Pick a start and end time.");
      return;
    }
    if (new Date(end) <= new Date(start)) {
      toast.error("End must be after start.");
      return;
    }
    setBusy(true);
    try {
      const lead = leadId === NO_LEAD ? null : leadId;
      const startsAt = localToIso(start);
      const endsAt = localToIso(end);

      if (isEdit && edit) {
        // Persist the editable metadata.
        const meta = await updateAppointment(edit.id, {
          title: title.trim() || undefined,
          location,
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
          location: location.trim() || undefined,
          notes: notes.trim() || undefined,
          allDay,
        });
        if (!res.ok) {
          toast.error(res.error || "Could not create appointment.");
          return;
        }
        toast.success(
          apptType === "survey" ? "Survey booked." : "Removal scheduled.",
        );
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
      <DialogContent className="sm:max-w-md">
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

        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label htmlFor="appt-type">Type</Label>
            <Select
              value={apptType}
              onValueChange={(v) => setApptType(v as ApptType)}
            >
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
            <Label htmlFor="appt-lead">
              Lead{" "}
              <span className="text-mist-400 font-normal">(optional)</span>
            </Label>
            <Select value={leadId} onValueChange={setLeadId}>
              <SelectTrigger id="appt-lead">
                <SelectValue placeholder="No lead (blocked time)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_LEAD}>No lead (blocked time)</SelectItem>
                {leads.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name || "Unnamed lead"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="appt-estimator">Estimator</Label>
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
            <p className="text-xs text-mist-400">Who does this visit — drives their pay + win stats.</p>
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

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="appt-start">Starts</Label>
              <Input
                id="appt-start"
                type="datetime-local"
                value={start}
                onChange={(e) => onStartChange(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="appt-end">Ends</Label>
              <Input
                id="appt-end"
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>

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

          <div className="grid gap-2">
            <Label htmlFor="appt-location">Location</Label>
            <Input
              id="appt-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Collection address / postcode"
            />
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
