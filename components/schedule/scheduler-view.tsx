"use client";

/**
 * FullCalendar wrapper for the three schedule surfaces (surveys / removals /
 * overlap). Colour-codes by appointment type:
 *   - survey  -> white bg, 1px mm-red border, mm-red text (outline chip)
 *   - removal -> solid charcoal (#1A1A1A) bg, white text
 *
 * Interactions:
 *   - dateClick / select  -> open the create dialog prefilled with that time
 *   - eventClick          -> open the edit dialog
 *   - eventDrop / resize  -> confirm() then rescheduleAppointment; revert on !ok
 *
 * Toolbar is restyled minimal to match the Marley shell (hairline borders,
 * today highlighted with a thin mm-red ring, Montserrat). iPad-friendly:
 * on a narrow viewport the default view drops to timeGridDay.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type {
  DateSelectArg,
  EventClickArg,
  EventDropArg,
  EventInput,
} from "@fullcalendar/core";
import type {
  DateClickArg,
  EventResizeDoneArg,
} from "@fullcalendar/interaction";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { rescheduleAppointment } from "@/app/(dashboard)/schedule/actions";
import {
  AppointmentDialog,
  type ApptType,
  type EditTarget,
  type LeadOption,
} from "./appointment-dialog";

export type SchedulerKind = "survey" | "removal" | "overlap";

export interface SchedulerEvent {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean | null;
  appt_type: ApptType;
  status: string | null;
  location: string | null;
  lead_id: string | null;
}

const CHARCOAL = "#1A1A1A";
const MM_RED = "#c03838";

const SURVEY_STYLE = {
  backgroundColor: "#ffffff",
  borderColor: MM_RED,
  textColor: MM_RED,
} as const;

const REMOVAL_STYLE = {
  backgroundColor: CHARCOAL,
  borderColor: CHARCOAL,
  textColor: "#ffffff",
} as const;

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function SchedulerView({
  view,
  events,
  leads,
}: {
  view: SchedulerKind;
  events: SchedulerEvent[];
  leads: LeadOption[];
}) {
  const calRef = useRef<FullCalendar | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [presetStart, setPresetStart] = useState<string | undefined>();
  const [presetEnd, setPresetEnd] = useState<string | undefined>();
  const [presetAllDay, setPresetAllDay] = useState<boolean | undefined>();

  // Default type for the create dialog from this surface.
  const defaultType: ApptType = view === "removal" ? "removal" : "survey";

  // Narrow-viewport detection for the default view (iPad portrait / phones).
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const apply = () => setIsNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const initialView = useMemo(() => {
    if (isNarrow) return "timeGridDay";
    if (view === "removal") return "dayGridMonth";
    return "timeGridWeek"; // surveys + overlap
  }, [view, isNarrow]);

  const fcEvents: EventInput[] = useMemo(
    () =>
      events.map((e) => {
        const style = e.appt_type === "removal" ? REMOVAL_STYLE : SURVEY_STYLE;
        const cancelled = e.status === "cancelled";
        return {
          id: e.id,
          title: e.title || (e.appt_type === "removal" ? "Removal" : "Survey"),
          start: e.starts_at,
          end: e.ends_at ?? undefined,
          allDay: !!e.all_day,
          ...style,
          classNames: cancelled ? ["mm-evt-cancelled"] : [],
          extendedProps: {
            apptType: e.appt_type,
            leadId: e.lead_id,
            status: e.status,
            location: e.location,
            title: e.title,
          },
        };
      }),
    [events],
  );

  const openCreate = useCallback(
    (start?: string, end?: string, allDay?: boolean) => {
      setEditTarget(null);
      setPresetStart(start);
      setPresetEnd(end);
      setPresetAllDay(allDay);
      setDialogOpen(true);
    },
    [],
  );

  const onDateClick = useCallback(
    (arg: DateClickArg) => {
      const start = toLocalInput(arg.date);
      openCreate(start, undefined, arg.allDay);
    },
    [openCreate],
  );

  const onSelect = useCallback(
    (arg: DateSelectArg) => {
      openCreate(toLocalInput(arg.start), toLocalInput(arg.end), arg.allDay);
      calRef.current?.getApi().unselect();
    },
    [openCreate],
  );

  const onEventClick = useCallback((arg: EventClickArg) => {
    const ep = arg.event.extendedProps as {
      apptType: ApptType;
      leadId: string | null;
      location: string | null;
      title: string | null;
    };
    setEditTarget({
      id: arg.event.id,
      apptType: ep.apptType,
      leadId: ep.leadId ?? null,
      title: ep.title ?? arg.event.title,
      location: ep.location ?? null,
      notes: null, // not loaded into the calendar payload; edit overwrites only if changed
      startsAt: arg.event.start ? arg.event.start.toISOString() : "",
      endsAt: arg.event.end ? arg.event.end.toISOString() : "",
    });
    setDialogOpen(true);
  }, []);

  const onEventMove = useCallback(
    async (arg: EventDropArg | EventResizeDoneArg) => {
      const ev = arg.event;
      if (!ev.start || !ev.end) {
        arg.revert();
        return;
      }
      if (!confirm("Move this appointment to the new time?")) {
        arg.revert();
        return;
      }
      const r = await rescheduleAppointment(
        ev.id,
        ev.start.toISOString(),
        ev.end.toISOString(),
      );
      if (!r.ok) {
        toast.error(r.error || "Could not reschedule.");
        arg.revert();
      } else {
        toast.success("Appointment moved.");
      }
    },
    [],
  );

  return (
    <div className="mm-scheduler relative">
      {view === "overlap" ? (
        <div className="text-mist-500 mb-3 flex items-center gap-4 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-[3px] border bg-white"
              style={{ borderColor: MM_RED }}
            />
            Survey
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-[3px]"
              style={{ backgroundColor: CHARCOAL }}
            />
            Removal
          </span>
        </div>
      ) : null}

      <div className="bg-card rounded-md border p-2 sm:p-3">
        <FullCalendar
          ref={calRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView={initialView}
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek,timeGridDay",
          }}
          buttonText={{
            today: "Today",
            month: "Month",
            week: "Week",
            day: "Day",
          }}
          height="auto"
          expandRows
          nowIndicator
          firstDay={1}
          weekends
          slotMinTime="07:00:00"
          slotMaxTime="20:00:00"
          allDaySlot
          dayMaxEvents={3}
          eventDisplay="block"
          displayEventEnd
          selectable
          selectMirror
          editable
          eventStartEditable
          eventDurationEditable
          events={fcEvents}
          dateClick={onDateClick}
          select={onSelect}
          eventClick={onEventClick}
          eventDrop={onEventMove}
          eventResize={onEventMove}
          eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        />
      </div>

      {/* Floating FAB to book a new appointment. */}
      <button
        type="button"
        onClick={() => openCreate()}
        aria-label="New appointment"
        className="bg-mm-red focus-visible:ring-ring/50 fixed bottom-6 right-6 z-30 inline-flex h-14 items-center gap-2 rounded-full px-5 text-sm font-medium text-white shadow-lg outline-none transition hover:brightness-95 focus-visible:ring-[3px]"
      >
        <Plus className="size-5" strokeWidth={1.75} />
        New appointment
      </button>

      <AppointmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        leads={leads}
        defaultType={defaultType}
        presetStart={presetStart}
        presetEnd={presetEnd}
        presetAllDay={presetAllDay}
        edit={editTarget}
      />

      <style jsx global>{`
        .mm-scheduler .fc {
          --fc-border-color: var(--border);
          --fc-page-bg-color: transparent;
          --fc-neutral-bg-color: var(--color-mist-50);
          --fc-today-bg-color: transparent;
          --fc-now-indicator-color: var(--color-mm-red);
          font-family: var(--font-montserrat, system-ui, sans-serif);
          font-size: 0.8125rem;
        }
        .mm-scheduler .fc .fc-toolbar-title {
          font-family: var(--font-display);
          font-size: 1.25rem;
          color: var(--foreground);
          font-weight: 500;
        }
        .mm-scheduler .fc .fc-button {
          background: transparent;
          border: 1px solid var(--border);
          color: var(--foreground);
          box-shadow: none;
          text-transform: none;
          font-size: 0.8125rem;
          padding: 0.4rem 0.7rem;
          font-weight: 500;
          border-radius: 0.375rem;
        }
        .mm-scheduler .fc .fc-button:hover {
          background: var(--color-mist-50);
          color: var(--foreground);
        }
        .mm-scheduler .fc .fc-button:focus,
        .mm-scheduler .fc .fc-button:focus-visible {
          box-shadow: 0 0 0 3px rgba(192, 56, 56, 0.25);
        }
        .mm-scheduler .fc .fc-button-primary:not(:disabled).fc-button-active,
        .mm-scheduler .fc .fc-button-primary:not(:disabled):active {
          background: var(--color-mm-red);
          border-color: var(--color-mm-red);
          color: #fff;
        }
        .mm-scheduler .fc .fc-button-primary:disabled {
          background: transparent;
          color: var(--color-mist-300);
          border-color: var(--border);
        }
        /* today: a thin mm-red ring, not a fill */
        .mm-scheduler .fc .fc-day-today {
          background: transparent !important;
        }
        .mm-scheduler .fc .fc-daygrid-day.fc-day-today .fc-daygrid-day-frame {
          box-shadow: inset 0 0 0 1px var(--color-mm-red);
          border-radius: 0.25rem;
        }
        .mm-scheduler .fc .fc-timegrid-col.fc-day-today {
          box-shadow: inset 0 0 0 1px var(--color-mm-red);
        }
        .mm-scheduler .fc .fc-col-header-cell-cushion,
        .mm-scheduler .fc .fc-daygrid-day-number {
          color: var(--color-mist-500);
          text-decoration: none;
          padding: 0.35rem 0.4rem;
        }
        .mm-scheduler .fc .fc-event {
          border-radius: 0.375rem;
          padding: 2px 4px;
          font-size: 0.75rem;
          min-height: 44px;
          cursor: pointer;
        }
        .mm-scheduler .fc .fc-daygrid-event {
          min-height: 0;
          padding: 1px 4px;
        }
        .mm-scheduler .fc .mm-evt-cancelled {
          opacity: 0.45;
          text-decoration: line-through;
        }
        .mm-scheduler .fc .fc-toolbar.fc-header-toolbar {
          margin-bottom: 0.75rem;
          flex-wrap: wrap;
          gap: 0.5rem;
        }
      `}</style>
    </div>
  );
}
