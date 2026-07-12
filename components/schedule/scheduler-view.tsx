"use client";

/**
 * FullCalendar wrapper for the schedule surfaces (surveys / removals; the
 * removals view can overlay surveys to spot clashes). Colour-codes by type:
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
  EventContentArg,
  EventDropArg,
  EventInput,
} from "@fullcalendar/core";
import type {
  DateClickArg,
  EventResizeDoneArg,
} from "@fullcalendar/interaction";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { rescheduleAppointment } from "@/app/(dashboard)/schedule/actions";
import {
  AppointmentDialog,
  type ApptType,
  type EditTarget,
  type LeadOption,
  type EstimatorOption,
} from "./appointment-dialog";
import { AppointmentViewDialog } from "./appointment-view-dialog";
import { RescheduleDialog } from "./reschedule-dialog";

export type SchedulerKind = "survey" | "removal";

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
  estimator_id: string | null;
}

const CHARCOAL = "#1A1A1A";
const MM_RED = "#c03838";
// Solid-but-subtle brand red, white text (Peter 2026-07-08: "nicer red, not too bright").
const EVENT_RED = MM_RED;

const SURVEY_STYLE = {
  backgroundColor: EVENT_RED,
  borderColor: EVENT_RED,
  textColor: "#ffffff",
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
  estimators,
  defaultEstimatorId,
  presetLeadId,
  presetLocation,
  openOnLoad = false,
  baseLocation,
}: {
  view: SchedulerKind;
  events: SchedulerEvent[];
  leads: LeadOption[];
  estimators: EstimatorOption[];
  defaultEstimatorId?: string | null;
  /** when navigated from a lead's "Book survey", auto-open the dialog prefilled */
  presetLeadId?: string | null;
  presetLocation?: string | null;
  /** Quick-create entry point: open a blank appointment dialog immediately. */
  openOnLoad?: boolean;
  /** business base address — origin for the view modal's route map */
  baseLocation: string;
}) {
  const calRef = useRef<FullCalendar | null>(null);
  const [dialogOpen, setDialogOpen] = useState(Boolean(presetLeadId || openOnLoad));
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewTarget, setViewTarget] = useState<EditTarget | null>(null);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reschedTarget, setReschedTarget] = useState<EditTarget | null>(null);
  const [reschedPresetDate, setReschedPresetDate] = useState<Date | null>(null);
  const [presetStart, setPresetStart] = useState<string | undefined>();
  const [presetEnd, setPresetEnd] = useState<string | undefined>();
  const [presetAllDay, setPresetAllDay] = useState<boolean | undefined>();
  // Removals view can overlay surveys to spot clashes (replaces the Overlap page).
  const [showSurveys, setShowSurveys] = useState(false);

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
    return "timeGridWeek"; // surveys
  }, [view, isNarrow]);

  // Arrived from a lead's "Book survey" — pop the create dialog straight away.
  // Cancelled appointments leave the diary entirely (the lead keeps the history).
  // On the removals calendar, surveys are hidden unless "Show surveys" is on.
  const shown = useMemo(() => {
    const live = events.filter((e) => e.status !== "cancelled");
    return view === "removal" && !showSurveys ? live.filter((e) => e.appt_type === "removal") : live;
  }, [events, view, showSurveys]);

  const fcEvents: EventInput[] = useMemo(
    () =>
      shown.map((e) => {
        const style = e.appt_type === "removal" ? REMOVAL_STYLE : SURVEY_STYLE;
        const cancelled = e.status === "cancelled";
        return {
          id: e.id,
          title: e.title || (e.appt_type === "removal" ? "Removal" : "Survey"),
          start: e.starts_at,
          end: e.ends_at ?? undefined,
          allDay: !!e.all_day,
          ...style,
          classNames: [`mm-evt--${e.appt_type}`, ...(cancelled ? ["mm-evt-cancelled"] : [])],
          extendedProps: {
            apptType: e.appt_type,
            leadId: e.lead_id,
            estimatorId: e.estimator_id,
            status: e.status,
            location: e.location,
            title: e.title,
          },
        };
      }),
    [shown],
  );

  // Custom event card — {time} / bold {full name} / {address}, plus WHO is doing
  // the visit as a contrasting initial-avatar pill on the time row.
  const estimatorById = useMemo(() => new Map(estimators.map((e) => [e.id, e.full_name])), [estimators]);
  const renderEvent = useCallback(
    (arg: EventContentArg) => {
      const ep = arg.event.extendedProps as { estimatorId: string | null; location: string | null };
      const estimator = ep.estimatorId ? estimatorById.get(ep.estimatorId) ?? null : null;
      const firstName = estimator ? estimator.split(/\s+/)[0] : null;
      const compact = arg.view.type === "dayGridMonth";
      // Titles are system-generated "Survey — Jane Smith" — the card shows just the name.
      const name = (arg.event.title || "").replace(/^(Survey|Removal)\s+—\s+/, "");
      return (
        <div className="mm-evt-card">
          <div className="mm-evt-top">
            {arg.timeText ? <span className="mm-evt-time">{arg.timeText}</span> : null}
            {firstName ? (
              <span className="mm-evt-est">
                <span className="mm-evt-est-chip">{firstName[0]}</span>
                {!compact ? firstName : null}
              </span>
            ) : null}
          </div>
          <div className="mm-evt-name">{name}</div>
          {!compact && ep.location ? <div className="mm-evt-loc">{ep.location}</div> : null}
        </div>
      );
    },
    [estimatorById],
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

  // Clicking an event opens the read-only VIEW modal first — editing is a
  // deliberate second step from there.
  const onEventClick = useCallback((arg: EventClickArg) => {
    const ep = arg.event.extendedProps as {
      apptType: ApptType;
      leadId: string | null;
      estimatorId: string | null;
      status: string | null;
      location: string | null;
      title: string | null;
    };
    setViewTarget({
      id: arg.event.id,
      apptType: ep.apptType,
      leadId: ep.leadId ?? null,
      estimatorId: ep.estimatorId ?? null,
      status: ep.status ?? null,
      title: ep.title ?? arg.event.title,
      location: ep.location ?? null,
      notes: null, // not loaded into the calendar payload; edit overwrites only if changed
      startsAt: arg.event.start ? arg.event.start.toISOString() : "",
      endsAt: arg.event.end ? arg.event.end.toISOString() : "",
    });
    setViewOpen(true);
  }, []);

  const onEventMove = useCallback(
    async (arg: EventDropArg | EventResizeDoneArg) => {
      const ev = arg.event;
      if (!ev.start) {
        arg.revert();
        return;
      }
      // Month view drops give a DATE but no meaningful time — revert the drop and
      // open the reschedule dialog instead (time entry + that day's availability).
      if (arg.view.type === "dayGridMonth") {
        const ep = ev.extendedProps as {
          apptType: ApptType;
          leadId: string | null;
          estimatorId: string | null;
          status: string | null;
          location: string | null;
          title: string | null;
        };
        const original = events.find((e) => e.id === ev.id);
        setReschedTarget({
          id: ev.id,
          apptType: ep.apptType,
          leadId: ep.leadId ?? null,
          estimatorId: ep.estimatorId ?? null,
          status: ep.status ?? null,
          title: ep.title ?? ev.title,
          location: ep.location ?? null,
          notes: null,
          startsAt: original?.starts_at ?? ev.start.toISOString(),
          endsAt: original?.ends_at ?? ev.end?.toISOString() ?? "",
        });
        setReschedPresetDate(ev.start);
        arg.revert();
        setReschedOpen(true);
        return;
      }
      // Time-grid drags land on an exact slot with the day's availability visible.
      if (!ev.end) {
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
    [events],
  );

  return (
    <div className="mm-scheduler relative">
      {view === "removal" ? (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setShowSurveys((s) => !s)}
            aria-pressed={showSurveys}
            className={cn(
              "focus-ring inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors",
              showSurveys
                ? "border-mm-red bg-mm-red-tint text-mm-red-deep"
                : "border-input bg-card text-mist-500 hover:bg-muted",
            )}
          >
            {showSurveys ? "Hide surveys" : "Show surveys"}
          </button>
          {showSurveys ? (
            <div className="flex items-center gap-4 text-xs text-mist-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-3 rounded-[3px]" style={{ backgroundColor: EVENT_RED }} />
                Survey
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-3 rounded-[3px]" style={{ backgroundColor: CHARCOAL }} />
                Removal
              </span>
            </div>
          ) : null}
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
          displayEventEnd={false}
          selectable
          selectMirror
          editable
          eventStartEditable
          eventDurationEditable
          events={fcEvents}
          eventContent={renderEvent}
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

      <AppointmentViewDialog
        open={viewOpen}
        onOpenChange={setViewOpen}
        target={viewTarget}
        lead={viewTarget?.leadId ? leads.find((l) => l.id === viewTarget.leadId) ?? null : null}
        estimatorName={viewTarget?.estimatorId ? estimatorById.get(viewTarget.estimatorId) ?? null : null}
        baseLocation={baseLocation}
        onEdit={() => {
          setViewOpen(false);
          setEditTarget(viewTarget);
          setDialogOpen(true);
        }}
        onReschedule={() => {
          setViewOpen(false);
          setReschedTarget(viewTarget);
          setReschedPresetDate(null);
          setReschedOpen(true);
        }}
      />

      <RescheduleDialog
        open={reschedOpen}
        onOpenChange={setReschedOpen}
        target={reschedTarget}
        estimatorName={reschedTarget?.estimatorId ? estimatorById.get(reschedTarget.estimatorId) ?? null : null}
        events={events}
        presetDate={reschedPresetDate}
      />

      <AppointmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        leads={leads}
        estimators={estimators}
        defaultEstimatorId={defaultEstimatorId}
        defaultType={defaultType}
        presetStart={presetStart}
        presetEnd={presetEnd}
        presetAllDay={presetAllDay}
        presetLeadId={presetLeadId ?? undefined}
        presetLocation={presetLocation ?? undefined}
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
          padding: 1px 5px;
          font-size: 0.75rem;
          min-height: 44px;
          cursor: pointer;
        }
        .mm-scheduler .fc .fc-daygrid-event {
          min-height: 0;
          padding: 2px 5px;
        }
        /* Event card — white-on-red, readable at a glance. Tight line metrics so
           {time} / {name} / {address} all fit inside a 1-hour slot. */
        .mm-evt-card {
          display: flex;
          flex-direction: column;
          gap: 0;
          min-width: 0;
          line-height: 1.15;
        }
        .mm-evt-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 4px;
        }
        .mm-evt-time {
          font-size: 0.65rem;
          font-weight: 600;
          opacity: 0.9;
          font-variant-numeric: tabular-nums;
        }
        .mm-evt-name {
          font-weight: 700;
          font-size: 0.75rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mm-evt-loc {
          font-size: 0.625rem;
          opacity: 0.85;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mm-evt-est {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 0.6875rem;
          font-weight: 500;
          opacity: 0.95;
          margin-top: 1px;
        }
        .mm-evt-est-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          flex: none;
          border-radius: 999px;
          font-size: 0.625rem;
          font-weight: 700;
        }
        /* Estimator pill contrasts with the card: charcoal on red surveys, red on charcoal removals. */
        .mm-evt--survey .mm-evt-est-chip {
          background: ${CHARCOAL};
          color: #fff;
        }
        .mm-evt--removal .mm-evt-est-chip {
          background: ${MM_RED};
          color: #fff;
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
