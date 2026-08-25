"use client";

/**
 * FullCalendar wrapper for the schedule surfaces (surveys / removals; the
 * removals view can overlay surveys to spot clashes).
 *
 * Colour model (multi-brand PRD §4 + §10): fill encodes brand × appt_type,
 * resolved by styleFor() from the slim `brands` prop:
 *   - DEFAULT_BRAND, unknown slug, or missing colours -> today's constants:
 *     removal solid charcoal #1A1A1A / white text; survey AND pack solid
 *     brand red #C03838 / white text. This arm IS the single-brand parity
 *     contract — Marley renders byte-identical with the brand layer off.
 *   - any other brand (a data rule, never a slug switch): removal fills
 *     colour_primary; survey/pack fills colour_accent (no accent -> the
 *     primary). Text is white where it passes the WCAG 3:1 large-text bar
 *     on that fill, else charcoal on a removal and the brand's primary on a
 *     survey (yellow blocks take blue text) — the lib/brand.ts
 *     brandCtaColour rule applied to diary fills.
 *   - hollow-unconfirmed (NOT gated on multi-brand — Marley gets it): a
 *     removal whose lead has no date_confirmed_at renders transparent with
 *     a 2px dashed border and text in that brand's removal colour, filling
 *     solid the moment confirmation lands. Surveys and packs are always
 *     solid (no confirmation concept).
 *   - multi-brand only: the brand initial joins the event's time row as a
 *     second signal that doesn't rely on colour vision, and a per-brand
 *     legend row renders above the calendar.
 *
 * Interactions:
 *   - dateClick / select  -> open the create dialog prefilled with that time
 *   - eventClick          -> open the edit dialog
 *   - eventDrop / resize  -> confirm() then rescheduleAppointment; revert on !ok
 *
 * Toolbar is restyled minimal to match the Marley shell (hairline borders,
 * today highlighted with a thin mm-red ring, Montserrat) — the mm-red chrome
 * (now-indicator, today ring, buttons) is app chrome, not record branding,
 * and stays Marley red in every mode. iPad-friendly: on a narrow viewport
 * the default view drops to timeGridDay.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import enGbLocale from "@fullcalendar/core/locales/en-gb";
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
import { DEFAULT_BRAND } from "@/lib/brand";
import { rescheduleAppointment } from "@/app/(dashboard)/schedule/actions";
import { slotRangeFor } from "@/lib/schedule/slot-range";
import {
  AppointmentDialog,
  type ApptType,
  type EditTarget,
  type LeadOption,
  type EstimatorOption,
} from "./appointment-dialog";
import { AppointmentViewDialog } from "./appointment-view-dialog";
import { RescheduleDialog } from "./reschedule-dialog";
import { ChangeDateDialog } from "@/components/bookings/change-date-dialog";

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
  /** Carried through so the edit dialog can seed the real text. It used to be
   *  absent from every schedule page's select, so the dialog seeded blank and
   *  saving wiped whatever was typed at booking time. */
  notes?: string | null;
  /** appointments.brand — styleFor resolves the fill from it. Absent or
   *  unknown renders today's Marley constants (the parity contract). */
  brand?: string;
  /** Removals only: false while the lead's date_confirmed_at is null →
   *  hollow rendering. Callers that don't stamp it (the allocation view's
   *  RescheduleDialog feed) get solid events — decorating fails soft. */
  dateConfirmed?: boolean;
}

/** Slim active-brand row for the diary colour lookup + legend — only the
 *  fields this client actually needs (multi-brand PRD §4). */
export interface BrandDiaryOption {
  slug: string;
  /** Full brand name — structurally satisfies the booking dialog's
   *  ApptBrandOption, so the same rows feed its bare-client picker. */
  name: string;
  shortName: string;
  /** Diary meta-line letter (brands.initial); null renders no second signal. */
  initial: string | null;
  colourPrimary: string | null;
  colourAccent: string | null;
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

interface EventStyle {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
}

/* Local copies of lib/brand.ts's private hex/contrast helpers (the
   brandCtaColour precedent — same 3:1 WCAG large-text bar). Not exported
   there; a client bundle shouldn't pull the server brand-reader module for
   two pure ten-line functions. */
const parseHex = (v: string | null): [number, number, number] | null => {
  if (!v) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const srgbChannel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const whiteTextLegible = ([r, g, b]: [number, number, number]): boolean => {
  const luminance = 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
  return 1.05 / (luminance + 0.05) >= 3;
};

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
  brands = [],
  multiBrand = false,
  brandFilterSlot,
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
  /** Slim listActiveBrands rows — feeds styleFor, the meta-line initial and
   *  the legend. Safe to pass single-brand: the UI gates on multiBrand. */
  brands?: BrandDiaryOption[];
  /** listActiveBrands().length > 1, computed server-side (the single-brand
   *  invariant, PRD §1) — every piece of brand UI here hangs off it. */
  multiBrand?: boolean;
  /** Multi-brand only: the BrandFilter control. The removals page renders it
   *  into the toolbar row beside "Show surveys" via this slot (that row
   *  lives client-side); the surveys page puts it in its PageHeader. */
  brandFilterSlot?: React.ReactNode;
}) {
  const calRef = useRef<FullCalendar | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [dialogOpen, setDialogOpen] = useState(Boolean(presetLeadId || openOnLoad));

  // The auto-open params (?new=1 / ?leadId=…) are one-shot: once the create
  // dialog closes, strip them so a refresh or share of the URL doesn't
  // unexpectedly reopen the dialog.
  const closeCreateDialog = useCallback(
    (open: boolean) => {
      setDialogOpen(open);
      if (!open && (searchParams.has("new") || searchParams.has("leadId"))) {
        const next = new URLSearchParams(searchParams);
        next.delete("new");
        next.delete("leadId");
        const qs = next.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      }
    },
    [pathname, router, searchParams],
  );
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewTarget, setViewTarget] = useState<EditTarget | null>(null);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reschedTarget, setReschedTarget] = useState<EditTarget | null>(null);
  const [reschedPresetDate, setReschedPresetDate] = useState<Date | null>(null);
  // Booked removals reschedule through the Payments Policy v2 ChangeDateDialog
  // (single date-change path — inside the 7-day window it snapshots held money
  // into the refund queue). This carries a dropped slot into that dialog.
  const [reschedPresetSlot, setReschedPresetSlot] = useState<{ startsAt: string; endsAt: string } | null>(null);
  /** Time-grid drag: the dropped slot is exact, so it seeds the dialog verbatim. */
  const [reschedPresetExact, setReschedPresetExact] = useState<Date | null>(null);
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

  // brand × appt_type style lookup. DEFAULT_BRAND is skipped here on purpose
  // so it can only ever resolve to the constants above — Marley parity by
  // construction, not by the seeded row happening to carry the right hex.
  const brandStyles = useMemo(() => {
    const map = new Map<string, { removal: EventStyle; survey: EventStyle }>();
    for (const b of brands) {
      if (b.slug === DEFAULT_BRAND) continue;
      const primary = parseHex(b.colourPrimary);
      if (!primary) continue; // no usable primary -> the default constants
      const removal: EventStyle = {
        backgroundColor: b.colourPrimary!,
        borderColor: b.colourPrimary!,
        textColor: whiteTextLegible(primary) ? "#ffffff" : CHARCOAL,
      };
      const accent = parseHex(b.colourAccent);
      const survey: EventStyle = accent
        ? {
            backgroundColor: b.colourAccent!,
            borderColor: b.colourAccent!,
            // A light accent (Pitmans yellow) takes the brand's primary as
            // text — yellow blocks get blue text (PRD §10 Colours).
            textColor: whiteTextLegible(accent) ? "#ffffff" : b.colourPrimary!,
          }
        : removal; // missing accent falls back to the colour_primary fill
      map.set(b.slug, { removal, survey });
    }
    return map;
  }, [brands]);

  const styleFor = useCallback(
    (brandSlug: string | null | undefined, apptType: ApptType): EventStyle => {
      const entry = brandSlug ? brandStyles.get(brandSlug) : undefined;
      if (!entry) return apptType === "removal" ? REMOVAL_STYLE : SURVEY_STYLE;
      return apptType === "removal" ? entry.removal : entry.survey;
    },
    [brandStyles],
  );

  const brandInitialBySlug = useMemo(
    () => new Map(brands.map((b) => [b.slug, b.initial])),
    [brands],
  );

  const fcEvents: EventInput[] = useMemo(
    () =>
      shown.map((e) => {
        const style = styleFor(e.brand, e.appt_type);
        // Hollow-unconfirmed: only an explicit false — a caller that doesn't
        // stamp dateConfirmed renders solid, and surveys/packs always do.
        const hollow = e.appt_type === "removal" && e.dateConfirmed === false;
        const colours = hollow
          ? {
              backgroundColor: "transparent",
              borderColor: style.backgroundColor,
              textColor: style.backgroundColor,
            }
          : style;
        const cancelled = e.status === "cancelled";
        return {
          id: e.id,
          title: e.title || (e.appt_type === "removal" ? "Removal" : "Survey"),
          start: e.starts_at,
          end: e.ends_at ?? undefined,
          allDay: !!e.all_day,
          ...colours,
          classNames: [
            `mm-evt--${e.appt_type}`,
            ...(hollow ? ["mm-evt--hollow"] : []),
            ...(cancelled ? ["mm-evt-cancelled"] : []),
          ],
          extendedProps: {
            apptType: e.appt_type,
            leadId: e.lead_id,
            estimatorId: e.estimator_id,
            status: e.status,
            location: e.location,
            title: e.title,
            notes: e.notes ?? null,
            brand: e.brand ?? null,
          },
        };
      }),
    [shown, styleFor],
  );

  // The time-grid window. Fixed at 07:00-20:00 this SILENTLY dropped anything
  // outside it from Week/Day view — no "+N more", no scroll cue (QA-20260823-06).
  // Derived from what is actually on the calendar so an out-of-hours job pulls the
  // grid open instead of falling off it, while a normal day keeps the tight range.
  // Uses `shown`, not `events`: a survey hidden by the removals filter must not
  // stretch the grid for a job you cannot see.
  const { slotMinTime, slotMaxTime } = useMemo(() => slotRangeFor(shown), [shown]);

  // Custom event card — {time} / bold {full name} / {address}, plus WHO is doing
  // the visit as a contrasting initial-avatar pill on the time row.
  const estimatorById = useMemo(() => new Map(estimators.map((e) => [e.id, e.full_name])), [estimators]);
  const renderEvent = useCallback(
    (arg: EventContentArg) => {
      const ep = arg.event.extendedProps as {
        estimatorId: string | null;
        location: string | null;
        brand: string | null;
      };
      const estimator = ep.estimatorId ? estimatorById.get(ep.estimatorId) ?? null : null;
      const firstName = estimator ? estimator.split(/\s+/)[0] : null;
      // Brand initial on the time row (multi-brand only) — the second signal,
      // so charcoal-vs-blue never rides on colour vision alone (PRD §4).
      const brandInitial =
        multiBrand && ep.brand ? brandInitialBySlug.get(ep.brand) ?? null : null;
      const compact = arg.view.type === "dayGridMonth";
      // Titles are system-generated "Survey — Jane Smith" — the card shows just the name.
      const name = (arg.event.title || "").replace(/^(Survey|Removal)\s+—\s+/, "");
      return (
        <div className="mm-evt-card">
          <div className="mm-evt-top">
            {arg.timeText ? <span className="mm-evt-time">{arg.timeText}</span> : null}
            {brandInitial ? <span className="mm-evt-brand">{brandInitial}</span> : null}
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
    [estimatorById, brandInitialBySlug, multiBrand],
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
      notes: string | null;
    };
    setViewTarget({
      id: arg.event.id,
      apptType: ep.apptType,
      leadId: ep.leadId ?? null,
      estimatorId: ep.estimatorId ?? null,
      status: ep.status ?? null,
      title: ep.title ?? arg.event.title,
      location: ep.location ?? null,
      notes: ep.notes ?? null,
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
          notes: string | null;
        };
        const original = events.find((e) => e.id === ev.id);
        const originalStart = original?.starts_at ?? ev.start.toISOString();
        const originalEnd = original?.ends_at ?? ev.end?.toISOString() ?? "";
        setReschedTarget({
          id: ev.id,
          apptType: ep.apptType,
          leadId: ep.leadId ?? null,
          estimatorId: ep.estimatorId ?? null,
          status: ep.status ?? null,
          title: ep.title ?? ev.title,
          location: ep.location ?? null,
          notes: ep.notes ?? null,
          startsAt: originalStart,
          endsAt: originalEnd,
        });
        setReschedPresetDate(ev.start);
        setReschedPresetExact(null);
        if (ep.apptType === "removal" && ep.leadId) {
          // Pre-fill the policy dialog with the dropped DAY at the original
          // time of day (month drops carry no meaningful time).
          const base = new Date(originalStart);
          const baseEndMs = originalEnd ? new Date(originalEnd).getTime() : NaN;
          const duration =
            Number.isFinite(baseEndMs) && baseEndMs > base.getTime()
              ? baseEndMs - base.getTime()
              : 60 * 60 * 1000;
          const preset = new Date(ev.start);
          preset.setHours(base.getHours(), base.getMinutes(), 0, 0);
          setReschedPresetSlot({
            startsAt: preset.toISOString(),
            endsAt: new Date(preset.getTime() + duration).toISOString(),
          });
        } else {
          setReschedPresetSlot(null);
        }
        arg.revert();
        setReschedOpen(true);
        return;
      }
      // Time-grid drags land on an exact slot with the day's availability visible.
      if (!ev.end) {
        arg.revert();
        return;
      }
      {
        // Booked removals go through the SINGLE date-change path (Payments
        // Policy v2): revert the drag and open the policy dialog pre-filled
        // with the dropped slot — inside the 7-day window it needs the warning
        // + tick and a refund-queue snapshot, which a confirm() cannot carry.
        const ep = ev.extendedProps as { apptType: ApptType; leadId: string | null; estimatorId: string | null; status: string | null; location: string | null; title: string | null; notes: string | null };
        if (ep.apptType === "removal" && ep.leadId) {
          const original = events.find((e) => e.id === ev.id);
          setReschedTarget({
            id: ev.id,
            apptType: ep.apptType,
            leadId: ep.leadId,
            estimatorId: ep.estimatorId ?? null,
            status: ep.status ?? null,
            title: ep.title ?? ev.title,
            location: ep.location ?? null,
            notes: ep.notes ?? null,
            startsAt: original?.starts_at ?? ev.start.toISOString(),
            endsAt: original?.ends_at ?? ev.end.toISOString(),
          });
          setReschedPresetDate(null);
          setReschedPresetExact(null);
          setReschedPresetSlot({ startsAt: ev.start.toISOString(), endsAt: ev.end.toISOString() });
          arg.revert();
          setReschedOpen(true);
          return;
        }
      }
      // A SURVEY with a customer behind it writes to that customer when it
      // moves, so it must go through the dialog with the visible send tick box
      // rather than a bare confirm() — dragging used to fire a real email and a
      // billable SMS with nothing on screen saying so, and a resize (which
      // leaves the start alone) told them their survey had "moved" to the time
      // it was already at. Lead-less entries and packs contact nobody, so they
      // keep the quick drag.
      {
        const ep = ev.extendedProps as { apptType: ApptType; leadId: string | null; estimatorId: string | null; status: string | null; location: string | null; title: string | null; notes: string | null };
        if (ep.apptType === "survey" && ep.leadId) {
          const original = events.find((e) => e.id === ev.id);
          setReschedTarget({
            id: ev.id,
            apptType: ep.apptType,
            leadId: ep.leadId,
            estimatorId: ep.estimatorId ?? null,
            status: ep.status ?? null,
            title: ep.title ?? ev.title,
            location: ep.location ?? null,
            notes: ep.notes ?? null,
            startsAt: original?.starts_at ?? ev.start.toISOString(),
            endsAt: original?.ends_at ?? ev.end.toISOString(),
          });
          setReschedPresetDate(null);
          setReschedPresetSlot(null);
          setReschedPresetExact(ev.start);
          arg.revert();
          setReschedOpen(true);
          return;
        }
      }
      if (!confirm("Move this appointment to the new time?")) {
        arg.revert();
        return;
      }
      const r = await rescheduleAppointment(
        ev.id,
        ev.start.toISOString(),
        ev.end.toISOString(),
        // Nothing to send on this path by construction (no lead), but say so
        // explicitly so a future lead-bearing type can't silently start mailing.
        { notifyCustomer: false },
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
                ? "border-mm-red bg-mm-red text-white"
                : "border-input bg-card text-mist-500 hover:bg-muted",
            )}
          >
            {showSurveys ? "Hide surveys" : "Show surveys"}
          </button>
          {/* Single-brand only — the multi-brand legend below covers both
              types per brand, so this two-swatch version would duplicate it. */}
          {showSurveys && !multiBrand ? (
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
          {brandFilterSlot}
        </div>
      ) : null}

      {/* Multi-brand legend (PRD §4): one group per active brand, swatches
          for what THIS surface can show, plus the shared hollow note on the
          removals view. Single-brand renders nothing — the parity contract. */}
      {multiBrand ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-mist-500">
          {brands.map((b) => (
            <span key={b.slug} className="inline-flex items-center gap-1.5">
              <span className="font-semibold text-foreground">{b.shortName}</span>
              {view === "removal" ? (
                <>
                  <span
                    className="inline-block size-3 rounded-[3px]"
                    style={{ backgroundColor: styleFor(b.slug, "removal").backgroundColor }}
                  />
                  <span>Removal</span>
                </>
              ) : null}
              <span
                className="inline-block size-3 rounded-[3px]"
                style={{ backgroundColor: styleFor(b.slug, "survey").backgroundColor }}
              />
              <span>{view === "removal" ? "Survey/Pack" : "Survey"}</span>
            </span>
          ))}
          {view === "removal" ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block size-3 rounded-[3px] border-2 border-dashed"
                style={{ borderColor: CHARCOAL }}
              />
              <span>Dashed outline = date not yet confirmed</span>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="bg-card rounded-md border p-2 sm:p-3">
        <FullCalendar
          ref={calRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          // UK date formats everywhere (day headers were rendering the US
          // default "Mon 8/17"; en-gb also gives the "17 – 23 Aug 2026"
          // title). buttonText/eventTimeFormat below still override locale.
          locale={enGbLocale}
          // Peter's preferred header: "Mon 17 Aug", not numeric "17/08".
          // Scoped to the time-grid views — the month grid's columns are
          // weekday names, not dates, so a global format would mislabel them.
          views={{
            timeGridWeek: {
              dayHeaderFormat: { weekday: "short", day: "numeric", month: "short", omitCommas: true },
            },
            timeGridDay: {
              dayHeaderFormat: { weekday: "long", day: "numeric", month: "short", omitCommas: true },
            },
          }}
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
          slotMinTime={slotMinTime}
          slotMaxTime={slotMaxTime}
          allDaySlot
          // No cap: a month row grows to fit its busiest day rather than
          // collapsing the 4th job into a "+1 more" link. Hiding work on the
          // fullest days defeats the point of looking at the month.
          dayMaxEvents={false}
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
          setReschedPresetSlot(null);
          setReschedPresetExact(null);
          setReschedOpen(true);
        }}
      />

      {/* Booked removals (with a lead) reschedule through the Payments Policy
          v2 dialog — the single date-change path (free outside the 7-day
          window; warned cancel-and-rebook + refund-queue snapshot inside it).
          Surveys and lead-less diary entries keep the plain reschedule. */}
      {reschedTarget && reschedTarget.apptType === "removal" && reschedTarget.leadId ? (
        <ChangeDateDialog
          appointmentId={reschedTarget.id}
          leadId={reschedTarget.leadId}
          startsAt={reschedTarget.startsAt}
          endsAt={reschedTarget.endsAt}
          presetStartsAt={reschedPresetSlot?.startsAt ?? null}
          presetEndsAt={reschedPresetSlot?.endsAt ?? null}
          open={reschedOpen}
          onOpenChange={setReschedOpen}
        />
      ) : (
        <RescheduleDialog
          open={reschedOpen}
          onOpenChange={setReschedOpen}
          target={reschedTarget}
          estimatorName={reschedTarget?.estimatorId ? estimatorById.get(reschedTarget.estimatorId) ?? null : null}
          events={events}
          presetDate={reschedPresetDate}
          presetExact={reschedPresetExact}
          customerContact={(() => {
            const l = reschedTarget?.leadId ? leads.find((x) => x.id === reschedTarget.leadId) : null;
            return l ? [l.email, l.phone].filter(Boolean).join(" · ") || null : null;
          })()}
        />
      )}

      <AppointmentDialog
        open={dialogOpen}
        onOpenChange={closeCreateDialog}
        leads={leads}
        // Feeds the bare-client brand picker — without this the dialog's
        // brands default ([]) leaves requireBrand permanently false and a
        // bare-client booking dead-ends on the server's refusal
        // (QA gate-11 op7, 2026-08-25).
        brands={brands}
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
        /* Hollow-unconfirmed removal: FullCalendar inlines background-color,
           border-color and color from the event's colour props (transparent /
           removal colour / removal colour here) — width and style, which it
           has no props for, land via this class. */
        .mm-scheduler .fc .mm-evt--hollow {
          border-style: dashed;
          border-width: 2px;
        }
        /* Brand initial — the colour-vision-independent second signal on the
           time row (multi-brand only). margin-right:auto pins it beside the
           time and pushes the estimator pill back to the right edge. */
        .mm-evt-brand {
          font-size: 0.65rem;
          font-weight: 700;
          opacity: 0.9;
          margin-right: auto;
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
