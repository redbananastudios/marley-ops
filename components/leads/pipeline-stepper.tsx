"use client";

/**
 * Lead pipeline stepper — the 6-stage journey as compact connected chips under
 * the lead header. The current stage is filled brand-red; earlier stages are
 * muted-done with a tick; later stages are hollow. A lost lead shows the trail it
 * actually reached plus a grey terminal "Lost" chip. The single upcoming ("next")
 * chip is a LINK to the same destination the recommended-next-step advises —
 * navigation only, it never writes status. Scrolls horizontally inside its own
 * track on narrow screens so the page itself never scrolls sideways.
 */

import Link from "next/link";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { deriveStages, nextChipHref, type StageChip } from "@/lib/leads/funnel";

export function PipelineStepper({
  status,
  leadId,
  reachedStatus,
}: {
  status: string;
  leadId: string;
  /** For a lost lead: the furthest status it reached (drives the visible trail). */
  reachedStatus?: string | null;
}) {
  const stages = deriveStages(status, { reachedStatus });
  const nextIndex = stages.findIndex((s) => s.state === "upcoming");

  return (
    <nav aria-label="Pipeline progress" className="-mx-1 overflow-x-auto px-1">
      <ol className="flex min-w-max items-center gap-1">
        {stages.map((s, i) => {
          const href = i === nextIndex ? nextChipHref(s.key, leadId) : null;
          return (
            <li key={s.key} className="flex shrink-0 items-center gap-1">
              {i > 0 ? (
                <span
                  aria-hidden
                  className={cn("h-px w-3 shrink-0 sm:w-5", s.state === "done" ? "bg-mm-red/40" : "bg-border")}
                />
              ) : null}
              {href ? (
                <Link href={href} aria-label={`Go to ${s.label} — next step`} className="focus-ring rounded-pill">
                  <Chip stage={s} interactive />
                </Link>
              ) : (
                <Chip stage={s} />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Chip({ stage, interactive = false }: { stage: StageChip; interactive?: boolean }) {
  const { state, label } = stage;
  return (
    <span
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-pill px-2.5 py-1 text-xs font-medium transition-colors",
        state === "current" && "bg-mm-red font-semibold text-white",
        state === "done" && "bg-muted text-mist-500",
        state === "upcoming" && "border border-input bg-card text-mist-400",
        state === "lost" && "bg-mist-200 text-mist-500",
        // The next chip is an upcoming chip that's also a link — pull it towards
        // brand red so it reads as the actionable one.
        interactive && "border-mm-red/40 text-mm-red-deep hover:border-mm-red hover:bg-mm-red-tint",
      )}
    >
      {state === "done" ? <Check className="size-3 text-mm-red" strokeWidth={2.5} /> : null}
      {state === "lost" ? <X className="size-3" strokeWidth={2.5} /> : null}
      {label}
    </span>
  );
}
