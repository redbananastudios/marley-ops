/**
 * Lead pipeline funnel — the single source of the 6-stage journey plus the pure,
 * dependency-free helpers that drive BOTH the lead action bar's "recommended next
 * step" and the pipeline stepper. Extracted so the funnel isn't duplicated across
 * the two client components (and so the stage logic is unit-testable).
 *
 *   Enquiry → Survey → Quoted → Deposit → Confirmed → Completed   (+ Lost, terminal)
 *
 * Status ↔ stage: website_enquiry=Enquiry, survey_booked=Survey, quoted=Quoted,
 * provisional=Deposit (quote accepted, deposit unpaid), confirmed=Confirmed,
 * completed=Completed. `declined` is the lost terminal (off the linear funnel).
 */

export const FUNNEL = [
  "website_enquiry",
  "survey_booked",
  "quoted",
  "provisional",
  "confirmed",
  "completed",
] as const;

export type FunnelStatus = (typeof FUNNEL)[number];
export type LeadStatus = FunnelStatus | "declined";

/** Index within the linear funnel; -1 for a closed/unknown status. */
export const funnelIndex = (status: string): number => FUNNEL.indexOf(status as FunnelStatus);

/** Closed = no forward step remains (won-complete, or lost). */
export const isClosed = (status: string): boolean => status === "completed" || status === "declined";

/**
 * True when both statuses sit on the linear funnel and the move goes DOWN it
 * (e.g. confirmed → quoted) — the rare "something went wrong" move that must
 * carry a reason. Off-funnel statuses are never backward: losses go through
 * mark-lost (its own reason + unwind) and reopening a declined lead is a
 * deliberate restart, not a regression.
 */
export const isBackwardMove = (from: string | null | undefined, to: string): boolean =>
  from != null && funnelIndex(to) >= 0 && funnelIndex(from) >= 0 && funnelIndex(to) < funnelIndex(from);

export interface PipelineStage {
  key: string;
  label: string;
  status: FunnelStatus;
}

/** The six display stages, 1:1 with the funnel statuses. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  { key: "enquiry", label: "Enquiry", status: "website_enquiry" },
  { key: "survey", label: "Survey", status: "survey_booked" },
  { key: "quoted", label: "Quoted", status: "quoted" },
  { key: "deposit", label: "Deposit", status: "provisional" },
  { key: "confirmed", label: "Confirmed", status: "confirmed" },
  { key: "completed", label: "Completed", status: "completed" },
] as const;

export type StageState = "done" | "current" | "upcoming" | "lost";

export interface StageChip {
  key: string;
  label: string;
  index: number;
  state: StageState;
}

/**
 * Signals used to work out how far a *lost* lead travelled before it died — the
 * status alone can't say (it just reads "declined"), so we infer from artefacts.
 */
export interface ReachedSignals {
  hasSurvey?: boolean;
  hasSentQuote?: boolean;
  hasAcceptedQuote?: boolean;
  depositPaid?: boolean;
}

/** Furthest funnel status a lead reached, inferred from its artefacts. */
export function deriveReachedStatus(s: ReachedSignals): FunnelStatus {
  if (s.hasAcceptedQuote && s.depositPaid) return "confirmed";
  if (s.hasAcceptedQuote) return "provisional";
  if (s.hasSentQuote) return "quoted";
  if (s.hasSurvey) return "survey_booked";
  return "website_enquiry";
}

/**
 * The stepper chips for a status. A live status fills every stage
 * (done / current / upcoming); `declined` shows only the trail it reached plus a
 * terminal grey "Lost" chip (its later stages never happened, so they're dropped).
 */
export function deriveStages(status: string, opts?: { reachedStatus?: string | null }): StageChip[] {
  if (status === "declined") {
    const ri = funnelIndex(opts?.reachedStatus ?? "website_enquiry");
    const reached = ri < 0 ? 0 : ri;
    const chips: StageChip[] = PIPELINE_STAGES.slice(0, reached + 1).map((s, i) => ({
      key: s.key,
      label: s.label,
      index: i,
      state: "done",
    }));
    chips.push({ key: "lost", label: "Lost", index: chips.length, state: "lost" });
    return chips;
  }
  const ci = funnelIndex(status);
  const current = ci < 0 ? 0 : ci;
  return PIPELINE_STAGES.map((s, i) => ({
    key: s.key,
    label: s.label,
    index: i,
    state: i < current ? "done" : i === current ? "current" : "upcoming",
  }));
}

/**
 * Navigation target for the *next* stage chip — the same destination the action
 * bar's recommended-next-step advises. Navigation only; the stepper NEVER writes
 * a status. Keyed by the target stage's key (book survey → survey booking, send
 * quote → new quote, deposit/confirmed → Bookings, completed → removal booking).
 */
export function nextChipHref(stageKey: string, leadId: string): string | null {
  switch (stageKey) {
    case "survey":
      return `/schedule/surveys?leadId=${leadId}`;
    case "quoted":
      return `/quotes/new?leadId=${leadId}`;
    case "deposit":
      return "/bookings";
    case "confirmed":
      return "/bookings";
    case "completed":
      return `/schedule/removals?leadId=${leadId}`;
    default:
      return null;
  }
}
