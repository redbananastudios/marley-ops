/**
 * Presentation rules for a /my-jobs job card, pure so they are unit-testable.
 *
 * The one rule that matters: a completed job must never render identically to
 * a job still to be done (QA-20260820-06 — a signed-off move kept its red MOVE
 * pill and looked exactly like the next job on the list). Completion is keyed
 * on `appointments.status`, which both the crew sign-off and the auto-complete
 * cron stamp to "completed".
 */

export type JobCardLook = {
  /** Left accent border classes on the card. */
  accent: string;
  /** The pill in the card corner. */
  pill: { label: string; cls: string };
  /** What kind of visit this is, for the card's subtitle line. */
  typeLabel: string;
  completed: boolean;
};

export function jobCardLook(apptType: string, status: string | null | undefined): JobCardLook {
  const typeLabel = apptType === "removal" ? "Move" : apptType === "pack" ? "Packing" : "Survey";
  if (status === "completed") {
    return {
      accent: "border-l-[3px] border-l-success",
      pill: { label: "Done", cls: "bg-success-bg text-success" },
      typeLabel,
      completed: true,
    };
  }
  return {
    accent:
      apptType === "removal"
        ? "border-l-[3px] border-l-mm-red"
        : apptType === "pack"
          ? "border-l-[3px] border-l-warn"
          : "border-l-[3px] border-l-survey",
    pill:
      apptType === "removal"
        ? { label: "Move", cls: "bg-mm-red text-white" }
        : apptType === "pack"
          ? { label: "Packing", cls: "bg-warn-bg text-warn" }
          : { label: "Survey", cls: "bg-muted text-mist-500" },
    typeLabel,
    completed: false,
  };
}
